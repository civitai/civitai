import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { SortFilter } from '~/components/Filters/SortFilter';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { FiltersProvider } from '~/providers/FiltersProvider';

// Whether the viewer plays Hat Turf: its own hook, tested through the server gate it mirrors.
const player = vi.hoisted(() => ({ value: null as { event: string; teams: string[] } | null }));
vi.mock('~/components/HatTurf/useHatTurfFeedPlayer', () => ({
  useHatTurfFeedPlayer: () => player.value,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
// Providers the harness does not mount, which throw rather than default.
vi.mock('~/components/Filters/useSortAvailability', () => ({
  useSortAvailability: () => ({ isModerator: false, canViewNsfw: true, showNsfw: true }),
}));
vi.mock('~/hooks/useIsClient', () => ({ default: () => true }));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'blue' }));
// Pickers that read tRPC; not under test.
vi.mock('~/components/Tool/ToolMultiSelect', () => ({ ToolMultiSelect: () => null }));
vi.mock('~/components/Technique/TechniqueMultiSelect', () => ({
  TechniqueMultiSelect: () => null,
}));
vi.mock('~/components/SfwOnlyBadge/BaseModelFilterSelect', () => ({
  BaseModelFilterSelect: () => null,
}));
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useIsMobile: () => false,
  isMobileDevice: () => false,
}));

const PLAYER = { event: 'e', teams: ['Blue', 'Green', 'Pink', 'Yellow'] };
const render = () =>
  renderWithProviders(
    <FiltersProvider>
      <SortFilter type="images" />
      <MediaFiltersDropdown filterType="images" isFeed />
    </FiltersProvider>
  );
const openSort = () => page.getByRole('button', { name: /Most Reactions|hats/ }).click();
const openFilters = () => page.getByRole('button', { name: 'Filters', exact: true }).click();

beforeEach(() => {
  player.value = null;
  // The filter store persists; each test starts from the defaults.
  localStorage.clear();
});

describe('Hat Turf in the image feed filters', () => {
  test('a player gets the Hat Turf sorts, and a normal sort leaves them', async () => {
    player.value = PLAYER;
    render();
    await openSort();
    await expect.element(page.getByText('Hat Turf')).toBeInTheDocument();
    await page.getByRole('menuitem', { name: 'Most hats' }).click();
    await expect.element(page.getByRole('button', { name: 'Most hats' })).toBeInTheDocument();
    await page.getByRole('button', { name: 'Most hats' }).click();
    await page.getByRole('menuitem', { name: 'Newest' }).click();
    await expect.element(page.getByRole('button', { name: 'Newest' })).toBeInTheDocument();
  });

  test('anyone else gets neither the sorts nor the Turf filters', async () => {
    render();
    await openSort();
    await expect.element(page.getByRole('menuitem', { name: 'Newest' })).toBeInTheDocument();
    expect(page.getByRole('menuitem', { name: 'Most hats' }).query()).toBeNull();
    await openFilters();
    await expect.element(page.getByText('Modifiers')).toBeInTheDocument();
    expect(page.getByText('Turf filters').query()).toBeNull();
  });

  test('on a normal sort, a player has both Show chips on and no team chips', async () => {
    player.value = PLAYER;
    render();
    await openFilters();
    await expect.element(page.getByText('Turf filters')).toBeInTheDocument();
    await expect.element(page.getByRole('checkbox', { name: 'Turf hats' })).toBeChecked();
    await expect.element(page.getByRole('checkbox', { name: 'Worn hats' })).toBeChecked();
    await expect.element(page.getByRole('checkbox', { name: 'Turf hats' })).toBeEnabled();
    expect(page.getByRole('checkbox', { name: 'Blue' }).query()).toBeNull();
    await expect.element(page.getByText('Time period')).toBeInTheDocument();
    await expect.element(page.getByRole('checkbox', { name: 'Remixes Only' })).toBeInTheDocument();
  });

  test('under a Hat Turf sort: team chips, Turf hats held on, and no time period', async () => {
    player.value = PLAYER;
    render();
    // Turf hats off on a normal sort first: a Hat Turf sort shows it on regardless.
    await openFilters();
    await page.getByRole('checkbox', { name: 'Turf hats' }).click();
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await openSort();
    await page.getByRole('menuitem', { name: 'Fewest hats' }).click();
    await openFilters();
    await expect.element(page.getByRole('checkbox', { name: 'Blue' })).toBeInTheDocument();
    await expect.element(page.getByRole('checkbox', { name: 'Blue' })).not.toBeChecked();
    await expect.element(page.getByRole('checkbox', { name: 'Turf hats' })).toBeDisabled();
    await expect.element(page.getByRole('checkbox', { name: 'Turf hats' })).toBeChecked();
    expect(page.getByText('Time period').query()).toBeNull();
    // The hydrate has no remix filter, so neither remix chip is offered.
    expect(page.getByRole('checkbox', { name: 'Remixes Only' }).query()).toBeNull();
    expect(page.getByRole('checkbox', { name: 'Originals Only' }).query()).toBeNull();
  });

  test('My live hats: every media type, Turf hats held on, no time period or remix chips', async () => {
    player.value = PLAYER;
    render();
    await openFilters();
    await expect.element(page.getByText('Media type')).toBeInTheDocument();
    await page.getByRole('checkbox', { name: 'My live hats' }).click();
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await openFilters();
    await expect.element(page.getByRole('checkbox', { name: 'My live hats' })).toBeChecked();
    await expect.element(page.getByRole('checkbox', { name: 'Turf hats' })).toBeDisabled();
    await expect.element(page.getByRole('checkbox', { name: 'Turf hats' })).toBeChecked();
    expect(page.getByText('Media type').query()).toBeNull();
    expect(page.getByText('Time period').query()).toBeNull();
    expect(page.getByRole('checkbox', { name: 'Remixes Only' }).query()).toBeNull();
  });
});
