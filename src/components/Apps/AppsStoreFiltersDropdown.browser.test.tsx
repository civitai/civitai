import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { AppsStoreFilters } from '~/components/Apps/appsStoreQueryParams';

/**
 * `/apps` store FILTERS DROPDOWN — the collapsed `[Filters ②]` control with chips, an Apply /
 * Reset footer and Clear all filters.
 *
 * What's under test is the PANEL BEHAVIOUR: the chips really are inside the dropdown, edits are
 * STAGED (nothing is emitted until Apply), no "All" chip exists (nothing starts checked), the count
 * previews the pending edit, and the mobile drawer renders. The count ARITHMETIC is pinned in the
 * blocking node suite (`__tests__/appsStoreQueryParams.test.ts`) — this is the wiring.
 */

const mocks = vi.hoisted(() => ({ mobile: false, isClient: true }));

// `AdaptiveFiltersDropdown` reaches for two providers the component harness does
// not mount, and BOTH throw rather than defaulting:
//  - `useIsClient()` → "missing IsClientContext" (gates the count Indicator);
//  - `useIsMobile()` → `useContainerContext()` (picks popover vs drawer).
// Unmocked, either takes the render down entirely.
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => mocks.isClient }));
// Spread the real module so newly added exports (e.g. useIsMobileDevice) keep resolving —
// a hand-listed mock breaks COLLECTION the moment the app chrome imports a new name from it.
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<object>()),
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

const chip = (name: string) => page.getByRole('checkbox', { name, exact: true });
const apply = () => page.getByRole('button', { name: 'Apply filters' });
const resetBtn = () => page.getByRole('button', { name: 'Reset', exact: true });
const clearAll = () => page.getByRole('button', { name: 'Clear all filters' });

describe('AppsStoreFiltersDropdown — the panel', () => {
  test('the chips are COLLAPSED behind the button until it is clicked', async () => {
    setup({ kind: 'all', category: null });
    await expect.element(trigger()).toBeInTheDocument();
    expect(panel().elements()).toHaveLength(0);
    await userEvent.click(trigger());
    await expect.element(panel()).toBeInTheDocument();
  });

  test('the panel holds BOTH groups — Type and Category — as chips, with no "All" chip', async () => {
    setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    await expect.element(page.getByText('Type')).toBeInTheDocument();
    await expect.element(page.getByText('Category')).toBeInTheDocument();
    await expect
      .element(page.getByRole('group', { name: 'Filter by app kind' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('group', { name: 'Filter by category' }))
      .toBeInTheDocument();
    await expect.element(chip('Embedded')).toBeInTheDocument();
    await expect.element(chip('Generation')).toBeInTheDocument();
    expect(page.getByText('All apps').elements()).toHaveLength(0);
    expect(page.getByText('All categories').elements()).toHaveLength(0);
  });

  test('with no filter set, NO chip is checked (nothing checked shows everything)', async () => {
    setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    await expect.element(chip('Embedded')).not.toBeChecked();
    await expect.element(chip('Standalone')).not.toBeChecked();
    await expect.element(chip('Generation')).not.toBeChecked();
    await expect.element(chip('Games')).not.toBeChecked();
  });

  test('a set filter shows only its own chips on', async () => {
    setup({ kind: 'offsite', category: 'games' });
    await userEvent.click(trigger());
    await expect.element(chip('Standalone')).toBeChecked();
    await expect.element(chip('Games')).toBeChecked();
    await expect.element(chip('Embedded')).not.toBeChecked();
    await expect.element(chip('Generation')).not.toBeChecked();
  });

  test('edits are STAGED: nothing is emitted until Apply, then one patch with both fields', async () => {
    const { onChange } = setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    await userEvent.click(chip('Embedded'));
    await userEvent.click(chip('Generation'));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(apply());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ kind: 'onsite', category: 'generation' });
  });

  test('Apply closes the panel', async () => {
    setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    await userEvent.click(chip('Embedded'));
    await userEvent.click(apply());
    await vi.waitFor(() => expect(panel().elements()).toHaveLength(0));
  });

  test('turning off the LAST kind chip goes back to all (a filter matching nothing is never offered)', async () => {
    const { onChange } = setup({ kind: 'offsite', category: null });
    await userEvent.click(trigger());
    await userEvent.click(chip('Standalone'));
    await expect.element(chip('Embedded')).not.toBeChecked();
    await expect.element(chip('Standalone')).not.toBeChecked();
    await userEvent.click(apply());
    expect(onChange).toHaveBeenCalledWith({ kind: 'all', category: null });
  });

  test('re-clicking the ACTIVE category goes back to all categories', async () => {
    const { onChange } = setup({ kind: 'all', category: 'generation' });
    await userEvent.click(trigger());
    await userEvent.click(chip('Generation'));
    await expect.element(chip('Generation')).not.toBeChecked();
    await expect.element(chip('Games')).not.toBeChecked();
    await userEvent.click(apply());
    expect(onChange).toHaveBeenCalledWith({ kind: 'all', category: null });
  });

  test('Apply and Reset are disabled until something changes; Reset discards the edit', async () => {
    const { onChange } = setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    await expect.element(apply()).toBeDisabled();
    await expect.element(resetBtn()).toBeDisabled();
    await userEvent.click(chip('Generation'));
    await expect.element(apply()).toBeEnabled();
    await userEvent.click(resetBtn());
    await expect.element(chip('Generation')).not.toBeChecked();
    await expect.element(apply()).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * The count badge. `AdaptiveFiltersDropdown` renders it as a Mantine `Indicator` whose `label` is
 * the number and which is `disabled` (renders no dot) at 0, so "shows 0" means "no badge", not
 * "a badge reading 0". While the panel is open it previews the pending edit.
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

  test('the badge previews the pending edit before Apply', async () => {
    setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    expect(badgeText()).toBeNull();
    await userEvent.click(chip('Generation'));
    expect(badgeText()).toBe('1');
  });
});

describe('AppsStoreFiltersDropdown — Clear all filters', () => {
  test('resets BOTH controls in one patch, and closes the panel', async () => {
    const { onChange } = setup({ kind: 'offsite', category: 'games' });
    await userEvent.click(trigger());
    await userEvent.click(clearAll());
    // One patch, not two: a two-call reset would write the URL twice and push a spurious history
    // entry between them.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ kind: 'all', category: null });
    await vi.waitFor(() => expect(panel().elements()).toHaveLength(0));
  });

  test('is ABSENT when nothing is filtered (not a silent no-op)', async () => {
    setup({ kind: 'all', category: null });
    await userEvent.click(trigger());
    await expect.element(panel()).toBeInTheDocument();
    expect(clearAll().elements()).toHaveLength(0);
  });

  test('does NOT touch the search box — it is outside this panel', async () => {
    const { onChange } = setup({ kind: 'onsite', category: null });
    await userEvent.click(trigger());
    await userEvent.click(clearAll());
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
    await expect.element(chip('Embedded')).toBeInTheDocument();
    await expect.element(chip('Generation')).toBeInTheDocument();
  });
});
