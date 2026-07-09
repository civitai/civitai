import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * M2 (audit) — CategoryFilterButtons icon FALLBACK.
 *
 * The category list (`MARKETPLACE_CATEGORIES`) is the single source of truth and
 * the icon map (`CATEGORY_ICONS`) is a SEPARATE const. If a category is added to
 * the list but NOT given an icon in the map, the old code rendered
 * `CATEGORY_ICONS[category]` = `undefined` as a component → React crashes the
 * whole filter row ("type is invalid"). The fix is
 * `CATEGORY_ICONS[category] ?? FALLBACK_CATEGORY_ICON`, so a not-yet-mapped
 * category renders the generic tag icon instead of crashing.
 *
 * This file MOCKS the categories constants to inject a synthetic, un-mapped
 * category (`mystery`) — proving the row survives a category with no icon. It's
 * a separate file from the main suite so the module-level mock doesn't leak into
 * the real-categories tests.
 */
vi.mock('~/server/services/blocks/marketplace-categories.constants', () => ({
  // `mystery` is intentionally NOT a key in CATEGORY_ICONS — it's the unmapped
  // category whose icon must fall back rather than crash.
  MARKETPLACE_CATEGORIES: ['generation', 'mystery'] as const,
  MARKETPLACE_CATEGORY_LABELS: {
    generation: 'Generation',
    mystery: 'Mystery',
  },
}));

// Import AFTER the mock (vi.mock is hoisted; static imports are not).
const { CategoryFilterButtons } = await import('./CategoryFilterButtons');

describe('CategoryFilterButtons — unmapped-category icon fallback (M2)', () => {
  test('a category with no entry in CATEGORY_ICONS renders the fallback icon (no crash)', async () => {
    const onChange = vi.fn();
    // Before the fix this render THROWS (undefined component for `mystery`).
    renderWithProviders(<CategoryFilterButtons value={null} onChange={onChange} />);

    // The whole row rendered: "All" + the mapped + the UNMAPPED category button.
    await expect.element(page.getByRole('button', { name: 'All categories' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Generation' })).toBeInTheDocument();
    const mystery = page.getByRole('button', { name: 'Mystery' });
    await expect.element(mystery).toBeInTheDocument();

    // The unmapped category still shows an icon (the fallback svg) rather than
    // an empty/broken button.
    expect(mystery.element().querySelector('svg')).not.toBeNull();

    // All buttons present = nothing crashed the row.
    expect(page.getByRole('button').elements()).toHaveLength(3);
  });
});
