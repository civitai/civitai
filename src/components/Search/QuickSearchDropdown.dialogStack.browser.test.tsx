import { Modal } from '@mantine/core';
// The harness loads no Mantine CSS, so without it modals and popovers are `position: static` and
// their z-indexes do nothing.
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// A registry dialog stacked at 300 + index vs the Mantine popover default of 300 hides the option list.

const HITS = vi.hoisted(() => [
  { id: 8801, username: 'first-candidate', image: null, deletedAt: null, cosmetics: [] },
  { id: 8802, username: 'second-candidate', image: null, deletedAt: null, cosmetics: [] },
]);

// The search modules build a Meilisearch client at import time; faked so none can send.
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
    // The REAL index name: the component maps `results.index` back to a render item, and an
    // unrecognised one silently falls back to the MODEL renderer, which then chokes on a
    // user-shaped hit. That fallback is a real code path, so feeding it the wrong name here
    // would be testing the wrong component.
    useHitsTransformed: () => ({ hits: HITS, results: { index: 'users_v3' } }),
  };
});
// Stub: the real renderer needs session context, avatars and cosmetics.
vi.mock('~/components/AutocompleteSearch/renderItems/users', async () => {
  const React = await import('react');
  const UserSearchItem = React.forwardRef((props: any, ref: any) =>
    React.createElement('div', { ref, 'data-testid': `option-${props.value}` }, props.value)
  );
  UserSearchItem.displayName = 'UserSearchItemStub';
  return { UserSearchItem };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  // All flags on; the test doesn't depend on any one.
  return { ...actual, useFeatureFlags: () => new Proxy({}, { get: () => true }) };
});
// The harness has no tRPC client or session, and the search scope reads both.
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

const { QuickSearchDropdown } = await import('~/components/Search/QuickSearchDropdown');
const { DialogProvider, useDialogContext } = await import('~/components/Dialog/DialogProvider');
const { dialogStore } = await import('~/components/Dialog/dialogStore');

function Picker() {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} title="Picker">
      <QuickSearchDropdown
        disableInitialSearch
        supportedIndexes={['users']}
        startingIndex="users"
        showIndexSelect={false}
        dropdownItemLimit={25}
        placeholder="Search"
        onItemSelected={() => undefined}
      />
    </Modal>
  );
}

function Outer() {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} title="Outer">
      <button onClick={() => dialogStore.trigger({ component: Picker })}>open picker</button>
    </Modal>
  );
}

beforeEach(() => {
  dialogStore.closeAll();
});

const optionIsReachable = async () => {
  await page.getByPlaceholder('Search').click();
  const option = page.getByTestId('option-8801');
  await expect.element(option).toBeInTheDocument();
  const el = option.element() as HTMLElement;
  const rect = el.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return el.contains(hit);
};

describe('QuickSearchDropdown inside registry dialogs', () => {
  test('the option list is above a dialog stacked on another dialog', async () => {
    renderWithProviders(<DialogProvider />);
    dialogStore.trigger({ component: Outer });
    await page.getByRole('button', { name: 'open picker' }).click();

    expect(await optionIsReachable()).toBe(true);
  });

  test('still above a single, un-stacked dialog', async () => {
    renderWithProviders(<DialogProvider />);
    dialogStore.trigger({ component: Picker });

    expect(await optionIsReachable()).toBe(true);
  });
});
