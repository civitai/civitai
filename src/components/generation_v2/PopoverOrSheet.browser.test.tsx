import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { MobileMenuDrawer } from '~/components/Drawer/MobileMenuDrawer';
import { PopoverOrSheet } from '~/components/generation_v2/PopoverOrSheet';
import { SelectInput } from '~/components/generation_v2/inputs/SelectInput';
import { SheetSelect } from '~/components/generation_v2/inputs/SheetSelect';
import type { GeneratorLayout } from '~/hooks/useMobileGenerator';
import type * as MobileGenerator from '~/hooks/useMobileGenerator';
import { historyLayersSettled, resetHistoryLayers } from '~/utils/history-layers';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';

// The layout comes from the flag and media queries, which the test browser can't vary.
let layout: GeneratorLayout = 'desktop';
vi.mock('~/hooks/useMobileGenerator', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileGenerator>()),
  useGeneratorLayout: () => layout,
}));

function Picker({ narrow }: { narrow?: 'sheet' | 'fullscreen' }) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <PopoverOrSheet
        opened={opened}
        onClose={() => setOpened(false)}
        title="Pick one"
        narrow={narrow}
        target={<button onClick={() => setOpened(true)}>Open</button>}
      >
        {(surface) => <p>Shown in a {surface}</p>}
      </PopoverOrSheet>
      <button>Elsewhere</button>
    </>
  );
}

const surfaceOpen = () => {
  if (document.querySelector('.mantine-Popover-dropdown')) return 'popover';
  if (document.querySelector('.mantine-Drawer-content')) return 'sheet';
  if (document.querySelector('.mantine-Modal-content')) return 'fullscreen';
  return null;
};

const openPicker = async (narrow?: 'sheet' | 'fullscreen') => {
  renderWithProviders(<Picker narrow={narrow} />);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect.element(page.getByText(/^Shown in a/)).toBeInTheDocument();
};

describe('PopoverOrSheet', () => {
  beforeEach(async () => {
    await historyLayersSettled();
    resetHistoryLayers();
    layout = 'desktop';
    useMobileGeneratorStore.setState({ showing: false });
  });

  test('opens a popover on desktop', async () => {
    await openPicker('fullscreen');
    expect(surfaceOpen()).toBe('popover');
    await expect.element(page.getByText('Shown in a popover')).toBeInTheDocument();
  });

  test('closes the popover on an outside click, and opens again from the target', async () => {
    await openPicker();
    await page.getByRole('button', { name: 'Elsewhere' }).click();
    await expect.element(page.getByText(/^Shown in a/)).not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Open' }).click();
    await expect.element(page.getByText('Shown in a popover')).toBeInTheDocument();
  });

  test('opens a titled bottom sheet in the mobile generator, whatever the legacy surface', async () => {
    layout = 'mobile';
    await openPicker('fullscreen');
    expect(surfaceOpen()).toBe('sheet');
    await expect.element(page.getByRole('dialog', { name: 'Pick one' })).toBeInTheDocument();
  });

  test('Back closes the sheet in the mobile generator', async () => {
    layout = 'mobile';
    useMobileGeneratorStore.setState({ showing: true });
    // An entry of the test page's own under the layer: without the layer, Back fails the test here
    // instead of leaving the page.
    history.pushState(history.state, '');
    await openPicker();
    history.back();
    await expect.element(page.getByText(/^Shown in a/)).not.toBeInTheDocument();
  });

  test('keeps the legacy surface on a narrow screen without the mobile generator', async () => {
    layout = 'narrow';
    await openPicker('fullscreen');
    expect(surfaceOpen()).toBe('fullscreen');
  });

  test('defaults the legacy narrow surface to a sheet', async () => {
    layout = 'narrow';
    await openPicker();
    expect(surfaceOpen()).toBe('sheet');
  });

  test('closes the sheet on Escape', async () => {
    layout = 'mobile';
    await openPicker();
    await expect.element(page.getByRole('dialog', { name: 'Pick one' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByText(/^Shown in a/)).not.toBeInTheDocument();
  });
});

const SAMPLERS = [
  { group: 'Fast', items: ['Euler', 'Euler a'] },
  { group: 'Quality', items: ['DPM++ 2M'] },
];

describe('SheetSelect', () => {
  beforeEach(() => {
    layout = 'mobile';
  });

  test('in the mobile generator, shows the value and lists the options, grouped, in a sheet', async () => {
    renderWithProviders(
      <SheetSelect label="Sampler" data={SAMPLERS} value="Euler a" onChange={vi.fn()} />
    );
    const field = page.getByRole('button', { name: 'Sampler' });
    await expect.element(field).toHaveTextContent('Euler a');
    await field.click();

    const sheet = page.getByRole('dialog', { name: 'Sampler' });
    await expect.element(sheet).toBeInTheDocument();
    await expect.element(sheet.getByRole('group', { name: 'Quality' })).toBeInTheDocument();
    await expect
      .element(sheet.getByRole('option', { name: 'Euler a' }))
      .toHaveAttribute('aria-selected', 'true');
  });

  test('choosing an option reports it and closes the sheet', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <SheetSelect label="Sampler" data={SAMPLERS} value="Euler a" onChange={onChange} />
    );
    await page.getByRole('button', { name: 'Sampler' }).click();
    await page.getByRole('option', { name: 'DPM++ 2M' }).click();

    expect(onChange).toHaveBeenCalledWith(
      'DPM++ 2M',
      expect.objectContaining({ value: 'DPM++ 2M' })
    );
    await expect.element(page.getByRole('dialog', { name: 'Sampler' })).not.toBeInTheDocument();
  });

  test('re-choosing the current option closes without reporting a change', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <SheetSelect label="Sampler" data={SAMPLERS} value="Euler a" onChange={onChange} />
    );
    await page.getByRole('button', { name: 'Sampler' }).click();
    await page.getByRole('option', { name: 'Euler a' }).click();

    await expect.element(page.getByRole('dialog', { name: 'Sampler' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('a clearable select offers its placeholder first, which clears the value', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <SheetSelect
        label="Sampler"
        data={SAMPLERS}
        value="Euler a"
        placeholder="All samplers"
        clearable
        onChange={onChange}
      />
    );
    await page.getByRole('button', { name: 'Sampler', exact: true }).click();
    const all = page.getByRole('option', { name: 'All samplers' });
    await expect.element(all).toHaveAttribute('aria-selected', 'false');
    await all.click();

    expect(onChange).toHaveBeenCalledWith(null, undefined);
    await expect.element(page.getByRole('dialog', { name: 'Sampler' })).not.toBeInTheDocument();
  });

  test("a clearable select's field clears its value without opening the sheet", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <SheetSelect
        label="Sampler"
        data={SAMPLERS}
        value="Euler a"
        placeholder="All samplers"
        clearable
        onChange={onChange}
      />
    );
    await page.getByRole('button', { name: 'Clear Sampler' }).click();

    expect(onChange).toHaveBeenCalledWith(null, undefined);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test('opening a searchable select does not focus its search, so the keyboard stays down', async () => {
    renderWithProviders(
      <SheetSelect label="Sampler" data={SAMPLERS} value="Euler" searchable onChange={vi.fn()} />
    );
    await page.getByRole('button', { name: 'Sampler' }).click();
    const search = page.getByRole('textbox', { name: 'Search options' });
    await expect.element(search).toBeInTheDocument();
    await expect.element(search).not.toHaveFocus();
  });

  test('a searchable select filters the list and drops emptied groups', async () => {
    renderWithProviders(
      <SheetSelect label="Sampler" data={SAMPLERS} value="Euler" searchable onChange={vi.fn()} />
    );
    await page.getByRole('button', { name: 'Sampler' }).click();
    await page.getByRole('textbox', { name: 'Search options' }).fill('dpm');

    await expect.element(page.getByRole('option', { name: 'DPM++ 2M' })).toBeInTheDocument();
    await expect.element(page.getByRole('option', { name: 'Euler' })).not.toBeInTheDocument();
    await expect.element(page.getByRole('group', { name: 'Fast' })).not.toBeInTheDocument();
  });

  test('reopening the sheet clears the last search', async () => {
    renderWithProviders(
      <SheetSelect label="Sampler" data={SAMPLERS} value="Euler" searchable onChange={vi.fn()} />
    );
    await page.getByRole('button', { name: 'Sampler' }).click();
    await page.getByRole('textbox', { name: 'Search options' }).fill('dpm');
    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByRole('dialog', { name: 'Sampler' })).not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Sampler' }).click();
    await expect.element(page.getByRole('textbox', { name: 'Search options' })).toHaveValue('');
    await expect.element(page.getByRole('option', { name: 'Euler a' })).toBeInTheDocument();
  });

  test('a disabled option cannot be chosen', async () => {
    const data = [
      { value: 'Euler', label: 'Euler' },
      { value: 'LCM', label: 'LCM', disabled: true },
    ];
    renderWithProviders(
      <SheetSelect label="Sampler" data={data} value="Euler" onChange={vi.fn()} />
    );
    await page.getByRole('button', { name: 'Sampler' }).click();
    await expect.element(page.getByRole('option', { name: 'LCM' })).toBeDisabled();
  });

  test('SelectInput ties its wrapper label to the sheet field', async () => {
    renderWithProviders(
      <SelectInput
        label="Sampler"
        options={['Euler', 'Euler a']}
        value="Euler a"
        onChange={vi.fn()}
      />
    );
    const field = page.getByRole('button', { name: 'Sampler' });
    await expect.element(field).toHaveTextContent('Euler a');
    await field.click();
    await expect.element(page.getByRole('dialog', { name: 'Sampler' })).toBeInTheDocument();
  });

  test('is the Mantine Select everywhere else, the legacy generator on a phone included', async () => {
    layout = 'narrow';
    renderWithProviders(
      <SheetSelect label="Sampler" data={SAMPLERS} value="Euler a" onChange={vi.fn()} />
    );
    await expect.element(page.getByRole('textbox', { name: 'Sampler' })).toHaveValue('Euler a');
    expect(document.querySelector('[aria-haspopup="dialog"]')).toBeNull();
  });
});

describe('SheetSelect inside a sheet', () => {
  function Filters() {
    const [value, setValue] = useState<string | null>(null);
    return (
      <MobileMenuDrawer opened onClose={vi.fn()} title="Filters">
        <p>Other filters</p>
        <SheetSelect
          sheetTitle="Sampler"
          data={SAMPLERS}
          value={value}
          placeholder="All samplers"
          clearable
          onChange={setValue}
        />
      </MobileMenuDrawer>
    );
  }

  beforeEach(async () => {
    await historyLayersSettled();
    resetHistoryLayers();
    layout = 'mobile';
    useMobileGeneratorStore.setState({ showing: true });
  });

  test('opens its options in place of the sheet, and choosing one returns to it', async () => {
    renderWithProviders(<Filters />);
    await page.getByRole('button', { name: 'All samplers' }).click();

    await expect.element(page.getByRole('option', { name: 'DPM++ 2M' })).toBeVisible();
    await expect.element(page.getByText('Other filters')).not.toBeVisible();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    await page.getByRole('option', { name: 'DPM++ 2M' }).click();
    await expect.element(page.getByText('Other filters')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'DPM++ 2M' })).toBeVisible();
  });

  test('Back leaves the options for the sheet, not the sheet', async () => {
    history.pushState(history.state, '');
    renderWithProviders(<Filters />);
    await page.getByRole('button', { name: 'All samplers' }).click();
    await expect.element(page.getByRole('button', { name: 'Back' })).toBeVisible();

    history.back();
    await expect.element(page.getByText('Other filters')).toBeVisible();
    await expect.element(page.getByRole('option', { name: 'DPM++ 2M' })).not.toBeInTheDocument();
  });
});
