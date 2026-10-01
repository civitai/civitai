import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { AspectRatioInput } from '~/components/generation_v2/inputs/AspectRatioInput';
import { sdxlFullAspectRatioBuckets } from '~/shared/constants/generation.constants';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// The picker imposes one order — widest first — whatever order an ecosystem
// declares its options in, and a pick from "More" lands in its place in that
// order rather than in the row's last slot. The row is a Mantine SegmentedControl,
// one radio per segment; reading their values in DOM order reads the row.

const rowValues = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    .map((input) => input.value)
    .filter((value) => value !== '__more__');

const toValue = (value: string) => {
  const option = sdxlFullAspectRatioBuckets.find((o) => o.value === value)!;
  return { value, width: option.width, height: option.height };
};

function renderPicker(props: {
  value?: string;
  options: { value: string; width?: number; height?: number }[];
  priorityOptions?: string[];
}) {
  renderWithProviders(
    // Wide enough that maxVisible (5), not the container, caps the row.
    <div style={{ width: 800 }}>
      <AspectRatioInput
        value={props.value ? toValue(props.value) : undefined}
        options={props.options}
        priorityOptions={props.priorityOptions}
        onChange={vi.fn()}
      />
    </div>
  );
}

describe('AspectRatioInput order', () => {
  test('sorts a portrait-first list widest first', async () => {
    renderPicker({
      options: [
        { value: '9:16', width: 768, height: 1344 },
        { value: '1:1', width: 1024, height: 1024 },
        { value: '16:9', width: 1344, height: 768 },
      ],
    });

    await vi.waitFor(() => expect(rowValues()).toEqual(['16:9', '1:1', '9:16']));
  });

  test('shows the priority row widest first, whatever order it was declared in', async () => {
    renderPicker({
      value: '1:1',
      options: [...sdxlFullAspectRatioBuckets].reverse(),
      priorityOptions: ['2:3', '1:1', '3:2'],
    });

    await vi.waitFor(() => expect(rowValues()).toEqual(['3:2', '1:1', '2:3']));
  });

  test('without priorityOptions, a long list fills the row from its sorted middle', async () => {
    renderPicker({
      value: '1:1',
      // Declared tallest-first; the row must not depend on that.
      options: [...sdxlFullAspectRatioBuckets].reverse(),
    });

    // maxVisible 5 = four options + More, taken from 16:9..2:3 (the sorted middle).
    await vi.waitFor(() => expect(rowValues()).toEqual(['16:9', '3:2', '4:3', '1:1']));
  });

  test.each([
    ['21:9', ['21:9', '1:1', '2:3']],
    ['4:3', ['4:3', '1:1', '2:3']],
    ['3:4', ['3:2', '1:1', '3:4']],
    ['9:21', ['3:2', '1:1', '9:21']],
  ])('a pick of %s from More replaces its nearest neighbour in place', async (picked, row) => {
    renderPicker({
      value: picked,
      options: sdxlFullAspectRatioBuckets,
      priorityOptions: ['3:2', '1:1', '2:3'],
    });

    await vi.waitFor(() => expect(rowValues()).toEqual(row));
  });
});

describe('AspectRatioInput "More"', () => {
  // Click the More segment's label: Mantine hides the radio itself.
  const openMore = () => userEvent.click(page.getByText('More'));

  test('opens a bottom sheet titled with the label on a phone, and a pick closes it', async () => {
    await page.viewport(360, 780);
    const onChange = vi.fn();
    renderWithProviders(
      <AspectRatioInput
        label="Aspect Ratio"
        value={toValue('1:1')}
        options={sdxlFullAspectRatioBuckets}
        priorityOptions={['3:2', '1:1', '2:3']}
        onChange={onChange}
      />
    );

    await openMore();
    const sheet = page.getByRole('dialog');
    expect(document.querySelector('.mantine-Drawer-root')).not.toBeNull();
    await expect.element(sheet.getByText('Aspect Ratio')).toBeInTheDocument();
    // Sheet rows are sized for a thumb; the desktop popover keeps the compact size.
    await expect.element(sheet.getByText('21:9', { exact: true })).toHaveClass('text-base');

    await userEvent.click(sheet.getByText('21:9'));
    expect(onChange).toHaveBeenCalledWith({ value: '21:9', width: 1536, height: 640 });
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
  });

  test('keeps the popover on desktop', async () => {
    await page.viewport(1440, 900);
    renderWithProviders(
      <AspectRatioInput
        label="Aspect Ratio"
        value={toValue('1:1')}
        options={sdxlFullAspectRatioBuckets}
        priorityOptions={['3:2', '1:1', '2:3']}
        onChange={vi.fn()}
      />
    );

    await openMore();
    await expect.element(page.getByText('1536x640')).toBeInTheDocument();
    await expect.element(page.getByText('21:9', { exact: true }).last()).toHaveClass('text-sm');
    expect(document.querySelector('.mantine-Drawer-root')).toBeNull();
  });
});
