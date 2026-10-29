import { useState } from 'react';
import { Button, MantineProvider, Popover } from '@mantine/core';
import router from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { theme } from '~/providers/ThemeProvider';

const HITS = vi.hoisted(() => [{ id: 4401, name: 'My template model' }]);

// Only the search transport and the option renderer are faked; the Autocomplete, its Combobox
// and the Popover around it are the real Mantine components the bug lives between.
vi.mock('@meilisearch/instant-meilisearch', () => ({
  instantMeiliSearch: () => ({ search: async () => ({ results: [] }) }),
}));
vi.mock('react-instantsearch', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    InstantSearch: (props: any) => props.children,
    useSearchBox: () => ({ query: '', refine: () => undefined, isSearchStalled: false }),
  };
});
vi.mock('~/components/Search/CustomSearchComponents', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, BrowsingLevelFilter: () => null };
});
vi.mock('~/components/Search/search.utils2', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useHitsTransformed: () => ({ hits: HITS, results: { index: 'models_v9', nbHits: 1 } }),
  };
});
vi.mock('~/components/AutocompleteSearch/renderItems/models', async () => {
  const React = await import('react');
  const ModelSearchItem = React.forwardRef((props: any, ref: any) =>
    React.createElement('div', { ref }, props.label)
  );
  ModelSearchItem.displayName = 'ModelSearchItemStub';
  return { ModelSearchItem };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useFeatureFlags: () => new Proxy({}, { get: () => true }) };
});
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, BrowsingSettingsAddonsProvider: (props: any) => props.children };
});
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useCurrentUser: () => null };
});
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data: unknown[] }) => ({ items: data }),
}));

const { TemplateSelect } = await import('~/components/Resource/Wizard/TemplateSelect');

// The same Popover wiring as ModelWizard's "Use a template" button, under the app theme, whose
// Popover default (`withinPortal: false`) is part of the trap.
function TemplatePopover() {
  const [opened, setOpened] = useState(false);
  return (
    <MantineProvider theme={theme}>
      <Popover opened={opened} onChange={setOpened} width={400} position="bottom-end">
        <Popover.Target>
          <Button onClick={() => setOpened(true)}>Use a template</Button>
        </Popover.Target>
        <Popover.Dropdown p={4}>
          <TemplateSelect username="creator" onSelect={() => setOpened(false)} />
        </Popover.Dropdown>
      </Popover>
    </MantineProvider>
  );
}


async function openResults() {
  renderWithProviders(<TemplatePopover />);
  await userEvent.click(page.getByRole('button', { name: 'Use a template' }));
  await userEvent.click(page.getByPlaceholder('Search your models...'));
  const option = page.getByRole('option', { name: 'My template model' });
  await expect.element(option).toBeInTheDocument();
  return option;
}

function expectTemplateApplied() {
  expect(router.replace).toHaveBeenCalledWith('?templateId=4401', undefined, { shallow: true });
}

beforeEach(() => {
  vi.mocked(router.replace).mockClear();
});

// Mantine's Popover closes on an outside mousedown/touchstart and unmounts its dropdown after the
// exit transition (~150ms); the option only submits on the click that follows the release.
describe('TemplateSelect inside the template popover', () => {
  test('a quick click applies the template', async () => {
    const option = await openResults();
    await userEvent.click(option);
    expectTemplateApplied();
  });

  test('a mouse press held past the popover exit transition still applies the template', async () => {
    const option = await openResults();
    await userEvent.click(option, { delay: 400 });
    expectTemplateApplied();
  });

  test('a held touch still applies the template', async () => {
    const option = (await openResults()).element() as HTMLElement;
    const touch = () => [new Touch({ identifier: 1, target: option, clientX: 1, clientY: 1 })];
    option.dispatchEvent(
      new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: touch() })
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(option.isConnected).toBe(true);
    option.dispatchEvent(
      new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: touch() })
    );
    option.click();
    expectTemplateApplied();
  });
});
