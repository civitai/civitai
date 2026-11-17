// The harness loads no Mantine CSS; without it the dropdown is not positioned at all.
import '@mantine/core/styles.css';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useState } from 'react';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// The showcase picker asks for 25 results, enough to fill the 300px list. In a short window with the
// input partway down, the list must stay on screen and scroll to its last row.

const ROW_HEIGHT = 80;
const HITS = vi.hoisted(() =>
  Array.from({ length: 25 }, (_, i) => ({
    id: 9000 + i,
    username: `candidate-${i}`,
    image: null,
    deletedAt: null,
    cosmetics: [],
  }))
);

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
  // The real index name, so the users renderer (stubbed below) is the one picked.
  return { ...actual, useHitsTransformed: () => ({ hits: HITS, results: { index: 'users_v3' } }) };
});
// A fixed-height row: the real renderer needs session context, avatars and cosmetics.
vi.mock('~/components/AutocompleteSearch/renderItems/users', async () => {
  const React = await import('react');
  const UserSearchItem = React.forwardRef((props: any, ref: any) =>
    React.createElement('div', { ref, style: { height: 80 } }, props.value)
  );
  UserSearchItem.displayName = 'UserSearchItemStub';
  return { UserSearchItem };
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

const { QuickSearchDropdown } = await import('~/components/Search/QuickSearchDropdown');

const nextPaint = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function openListAt(viewport: { width: number; height: number }, inputTop: number) {
  await page.viewport(viewport.width, viewport.height);
  expect(window.innerHeight).toBe(viewport.height);
  renderWithProviders(
    <div style={{ paddingTop: inputTop, width: 600 }}>
      <QuickSearchDropdown
        disableInitialSearch
        supportedIndexes={['users']}
        startingIndex="users"
        showIndexSelect={false}
        dropdownItemLimit={25}
        placeholder="Search"
        onItemSelected={() => undefined}
      />
    </div>
  );
  await page.getByPlaceholder('Search').click();
  await expect.element(page.getByRole('option').nth(HITS.length - 1)).toBeInTheDocument();
  await nextPaint();

  const listbox = page.getByRole('listbox').element() as HTMLElement;
  const scroller = listbox.querySelector('.mantine-ScrollArea-viewport') as HTMLElement;
  const dropdown = listbox.closest('.mantine-Popover-dropdown') as HTMLElement;
  return { scroller, dropdown };
}

const inViewport = (el: Element) => {
  const rect = el.getBoundingClientRect();
  return rect.top >= 0 && rect.bottom <= window.innerHeight;
};

describe('QuickSearchDropdown option list and the viewport', () => {
  test('in a short window, the list stays on screen and its last row can be reached', async () => {
    // 600px tall with the input ~280px down: neither side has room for the 300px list.
    const { scroller, dropdown } = await openListAt({ width: 1280, height: 600 }, 280);

    await expect.poll(() => inViewport(dropdown)).toBe(true);

    scroller.scrollTop = scroller.scrollHeight;
    await nextPaint();
    const options = page.getByRole('option').elements();
    const last = options[options.length - 1];
    const rect = last.getBoundingClientRect();
    expect(inViewport(last)).toBe(true);
    expect(last.contains(document.elementFromPoint(rect.left + 10, rect.bottom - 2))).toBe(true);
  });

  test('with room to spare, the list keeps its full 300px height', async () => {
    const { scroller, dropdown } = await openListAt({ width: 1280, height: 900 }, 100);

    expect(inViewport(dropdown)).toBe(true);
    expect(scroller.clientHeight).toBe(300);
    // The rows overflow it, so the list scrolls rather than growing.
    expect(scroller.scrollHeight).toBeGreaterThanOrEqual(HITS.length * ROW_HEIGHT);
  });
});

// Combobox keeps the closed dropdown mounted (display: none) and reuses it on reopen, and `flip`
// measures it at its current height, so the room measured last time must not carry over.
test('reopened after the input moves, the list takes the roomier side again', async () => {
  await page.viewport(1280, 500);
  let moveInput: (top: number) => void = () => undefined;
  function Harness() {
    const [top, setTop] = useState(230);
    moveInput = setTop;
    return (
      <div style={{ paddingTop: top, width: 600 }}>
        <QuickSearchDropdown
          disableInitialSearch
          supportedIndexes={['users']}
          startingIndex="users"
          showIndexSelect={false}
          dropdownItemLimit={25}
          placeholder="Search"
          onItemSelected={() => undefined}
        />
      </div>
    );
  }
  renderWithProviders(<Harness />);
  const input = page.getByPlaceholder('Search');
  const dropdown = () =>
    page.getByRole('listbox').element().closest('.mantine-Popover-dropdown') as HTMLElement;

  // Cramped on both sides: the list opens below, shrunk.
  await input.click();
  await expect.poll(() => dropdown().dataset.position).toBe('bottom');
  await userEvent.keyboard('{Escape}');
  await expect.element(page.getByRole('listbox')).not.toBeInTheDocument();

  // Now ~256px below and ~292px above: the full list fits neither, and above is roomier.
  await page.viewport(1280, 600);
  moveInput(300);
  await input.click();
  await expect.poll(() => dropdown().dataset.position).toBe('top');
  expect(inViewport(dropdown())).toBe(true);
});
