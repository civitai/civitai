import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { AppsStoreFilters } from '~/components/Apps/appsStoreQueryParams';

/**
 * `/apps` store FILTERS DROPDOWN — the collapsed `[⚙ Filters ②]` control that
 * replaced two full-width rows of toggles.
 *
 * What's under test is the PANEL BEHAVIOUR: that the two control groups really
 * are inside the dropdown (not just rendered somewhere), that selecting either
 * one emits the right patch, that the count `Indicator` tracks exactly those two
 * controls, that Clear all resets both AND the count, and that the mobile drawer
 * path renders. The count ARITHMETIC is pinned in the blocking node suite
 * (`__tests__/appsStoreQueryParams.test.ts`) — this is the wiring.
 */

const mocks = vi.hoisted(() => ({ mobile: false, isClient: true }));

// `AdaptiveFiltersDropdown` reaches for two providers the component harness does
// not mount, and BOTH throw rather than defaulting:
//  - `useIsClient()` → "missing IsClientContext" (gates the count Indicator);
//  - `useIsMobile()` → `useContainerContext()` (picks popover vs drawer).
// Unmocked, either takes the render down entirely.
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => mocks.isClient }));
vi.mock('~/hooks/useIsMobile', () => ({
  useIsMobile: () => mocks.mobile,
  isMobileDevice: () => mocks.mobile,
}));

const { AppsStoreFiltersDropdown } = await import('./AppsStoreFiltersDropdown');

function setup(filters: Pick<AppsStoreFilters, 'kind' | 'category'>) {
  const onChange = vi.fn();
  renderWithProviders(<AppsStoreFiltersDropdown filters={filters} onChange={onChange} />);
  return { onChange };
}

const trigger = () => page.getByRole('button', { name: 'Filters' });
const panel = () => page.getByTestId('apps-store-filters-panel');

beforeEach(() => {
  mocks.mobile = false;
  mocks.isClient = true;
});

describe('AppsStoreFiltersDropdown — the panel', () => {
  test('the toggles are COLLAPSED behind the button until it is clicked', async () => {
    setup({ kind: 'all', category: null });
    await expect.element(trigger()).toBeInTheDocument();
    // The whole point of the change: two rows of toggles are no longer occupying
    // the page above the grid.
    expect(panel().elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: 'All apps' }).elements()).toHaveLength(0);

    await userEvent.click(trigger());
    await expect.element(panel()).toBeInTheDocument();
  });

  test('the panel holds BOTH groups — Type and Category — with their labels', async () => {
    setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    await expect.element(panel()).toBeInTheDocument();
    await expect.element(page.getByText('Type')).toBeInTheDocument();
    await expect.element(page.getByText('Category')).toBeInTheDocument();
    // Both groups keep their `role="group"` + `aria-label` from the extracted
    // components, so the panel is navigable by group, not as a flat button soup.
    await expect
      .element(page.getByRole('group', { name: 'Filter by app kind' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('group', { name: 'Filter by category' }))
      .toBeInTheDocument();
  });

  test('selecting a kind emits ONLY the kind patch', async () => {
    const { onChange } = setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    await userEvent.click(page.getByRole('button', { name: 'On-site' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'onsite' });
  });

  test('selecting a category emits ONLY the category patch', async () => {
    const { onChange } = setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    await userEvent.click(page.getByRole('button', { name: 'Generation' }));
    expect(onChange).toHaveBeenCalledWith({ category: 'generation' });
  });

  test('re-clicking the ACTIVE category clears it (single-select toggle survives the move)', async () => {
    const { onChange } = setup({ kind: 'all', category: 'generation' });
    await userEvent.click(trigger());
    await userEvent.click(page.getByRole('button', { name: 'Generation' }));
    expect(onChange).toHaveBeenCalledWith({ category: null });
  });

  test('the active selections are reflected as pressed inside the panel', async () => {
    setup({ kind: 'offsite', category: 'games' });
    await userEvent.click(trigger());
    await expect
      .element(page.getByRole('button', { name: 'Off-site' }))
      .toHaveAttribute('aria-pressed', 'true');
    await expect
      .element(page.getByRole('button', { name: 'Games' }))
      .toHaveAttribute('aria-pressed', 'true');
    await expect
      .element(page.getByRole('button', { name: 'All apps' }))
      .toHaveAttribute('aria-pressed', 'false');
  });
});

/**
 * The count badge. `AdaptiveFiltersDropdown` renders it as a Mantine `Indicator`
 * whose `label` is the number and which is `disabled` (i.e. renders no dot at
 * all) at 0 — so "shows 0" means "no badge is present", not "a badge reading 0".
 */
describe('AppsStoreFiltersDropdown — the Indicator count', () => {
  function badgeText() {
    const el = document.querySelector('.mantine-Indicator-indicator');
    return el?.textContent ?? null;
  }

  test('0 active → no badge at all', async () => {
    setup({ kind: 'all', category: null });
    await expect.element(trigger()).toBeInTheDocument();
    expect(badgeText()).toBeNull();
  });

  test('1 active (kind only) → 1', async () => {
    setup({ kind: 'onsite', category: null });
    await expect.element(trigger()).toBeInTheDocument();
    expect(badgeText()).toBe('1');
  });

  test('1 active (category only) → 1', async () => {
    setup({ kind: 'all', category: 'utility' });
    await expect.element(trigger()).toBeInTheDocument();
    expect(badgeText()).toBe('1');
  });

  test('2 active → 2 (the panel holds exactly two controls)', async () => {
    setup({ kind: 'offsite', category: 'utility' });
    await expect.element(trigger()).toBeInTheDocument();
    expect(badgeText()).toBe('2');
  });
});

describe('AppsStoreFiltersDropdown — Clear all', () => {
  test('resets BOTH controls in one patch — and therefore the count', async () => {
    const { onChange } = setup({ kind: 'offsite', category: 'games' });
    await userEvent.click(trigger());
    await userEvent.click(page.getByTestId('apps-store-filters-clear'));
    // One patch, not two: a two-call reset would write the URL twice and push a
    // spurious history entry between them.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ kind: 'all', category: null });
  });

  test('is DISABLED when there is nothing to clear (not a silent no-op)', async () => {
    setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    await expect.element(page.getByTestId('apps-store-filters-clear')).toBeDisabled();
  });

  test('does NOT touch the search box — it is outside this panel', async () => {
    const { onChange } = setup({ kind: 'onsite', category: null });
    await userEvent.click(trigger());
    await userEvent.click(page.getByTestId('apps-store-filters-clear'));
    // Wiping text the viewer can still see, from a control they cannot see, is
    // the surprise this omission avoids. The empty state's "Clear filters" is the
    // broader reset that DOES clear search.
    expect(onChange.mock.calls[0][0]).not.toHaveProperty('query');
  });
});

describe('AppsStoreFiltersDropdown — mobile', () => {
  test('the mobile path renders the drawer, with the same controls', async () => {
    mocks.mobile = true;
    setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    // Mantine's Drawer is a dialog; the popover path is not.
    await expect.element(page.getByRole('dialog')).toBeInTheDocument();
    await expect.element(panel()).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'All apps' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Generation' })).toBeInTheDocument();
  });
});
