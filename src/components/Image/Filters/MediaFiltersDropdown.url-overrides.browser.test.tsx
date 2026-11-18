import Router from 'next/router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { FiltersProvider, useFiltersContext } from '~/providers/FiltersProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

vi.mock('~/components/HatTurf/useHatTurfFeedPlayer', () => ({ useHatTurfFeedPlayer: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/hooks/useIsClient', () => ({ default: () => true }));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'blue' }));
vi.mock('~/components/Tool/ToolMultiSelect', () => ({ ToolMultiSelect: () => null }));
vi.mock('~/components/Technique/TechniqueMultiSelect', () => ({
  TechniqueMultiSelect: () => null,
}));
vi.mock('~/components/SfwOnlyBadge/BaseModelFilterSelect', () => ({
  BaseModelFilterSelect: () => null,
}));
// The picker looks names up over trpc; a stand-in shows the ids it holds and adds one.
vi.mock('~/components/Image/Filters/FeedTagFilter', () => ({
  FeedTagFilter: ({ value, onChange }: { value: number[]; onChange: (ids: number[]) => void }) => (
    <button type="button" onClick={() => onChange([...value, 42])}>
      tags:{value.join(',')}
    </button>
  ),
}));
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useIsMobile: () => false,
  isMobileDevice: () => false,
}));

function StorePeriod() {
  const period = useFiltersContext((state) => state.images.period);
  return <span data-testid="store-period">{period}</span>;
}

const render = () =>
  renderWithProviders(
    <FiltersProvider>
      <MediaFiltersDropdown filterType="images" isFeed />
      <StorePeriod />
    </FiltersProvider>
  );
const openFilters = () => page.getByRole('button', { name: 'Filters', exact: true }).click();

beforeEach(() => {
  // The filter store persists; each test starts from the defaults (period Week).
  localStorage.clear();
  Router.query = { period: 'Month', query: 'cats' };
  vi.mocked(Router.replace).mockClear();
});

afterEach(() => {
  Router.query = {};
  Router.pathname = '/';
});

describe('a store-backed image feed dropdown under a ?period= link', () => {
  test('shows the period the feed is filtered by, not the saved one', async () => {
    render();
    await openFilters();
    await expect.element(page.getByRole('radio', { name: 'Month' })).toBeChecked();
  });

  test('Apply saves the change and drops the URL param that would outrank it', async () => {
    render();
    await openFilters();
    await page.getByRole('radio', { name: 'Day' }).click();
    await page.getByRole('button', { name: 'Apply filters' }).click();

    await expect.element(page.getByTestId('store-period')).toHaveTextContent('Day');
    expect(Router.replace).toHaveBeenCalledTimes(1);
    // Only the overriding filter goes; the search the link carried stays.
    expect(vi.mocked(Router.replace).mock.calls[0][0]).toMatchObject({ query: { query: 'cats' } });
    expect(vi.mocked(Router.replace).mock.calls[0][0]).not.toHaveProperty('query.period');
  });

  test('Clear resets the store and drops the URL param that would outrank it', async () => {
    render();
    await openFilters();
    await page.getByRole('button', { name: 'Clear all filters' }).click();

    await expect.element(page.getByTestId('store-period')).toHaveTextContent('AllTime');
    expect(Router.replace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Router.replace).mock.calls[0][0]).toMatchObject({ query: { query: 'cats' } });
    expect(vi.mocked(Router.replace).mock.calls[0][0]).not.toHaveProperty('query.period');
  });
});

describe('a store-backed model gallery dropdown on a dynamic route', () => {
  test('Apply keeps the route params the pathname needs', async () => {
    Router.pathname = '/models/[id]/[[...slug]]';
    Router.query = { id: '1', slug: ['some-model'], period: 'Month' };
    renderWithProviders(
      <FiltersProvider>
        <MediaFiltersDropdown filterType="modelImages" />
      </FiltersProvider>
    );
    await openFilters();
    await page.getByRole('radio', { name: 'Day' }).click();
    await page.getByRole('button', { name: 'Apply filters' }).click();

    expect(Router.replace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Router.replace).mock.calls[0][0]).toEqual({
      pathname: '/models/[id]/[[...slug]]',
      query: { id: '1', slug: ['some-model'] },
    });
  });
});

describe('a dropdown backed by its own query', () => {
  test('shows its query, not the route, and leaves the route alone on Apply', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <FiltersProvider>
        <MediaFiltersDropdown filterType="images" query={{ period: 'Week' }} onChange={onChange} />
      </FiltersProvider>
    );
    await openFilters();
    await expect.element(page.getByRole('radio', { name: 'Week' })).toBeChecked();
    await page.getByRole('radio', { name: 'Day' }).click();
    await page.getByRole('button', { name: 'Apply filters' }).click();

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ period: 'Day' }));
    expect(Router.replace).not.toHaveBeenCalled();
  });
});

// `?tags=` has no store field: the dropdown stages it with the rest and writes it back to the URL,
// where the feed, the tag bar and the feed's search all read it.
describe("the main feed dropdown's tag filter", () => {
  const renderFeed = (showTags = true) =>
    renderWithProviders(
      <FiltersProvider>
        <MediaFiltersDropdown filterType="images" isFeed showTags={showTags} />
      </FiltersProvider>
    );

  beforeEach(() => {
    Router.query = { tags: ['5'], query: 'cats' };
  });

  test('starts from the tags the URL filters by and writes the change back on Apply', async () => {
    renderFeed();
    await openFilters();
    await page.getByRole('button', { name: 'tags:5' }).click();
    await page.getByRole('button', { name: 'Apply filters' }).click();

    expect(Router.replace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Router.replace).mock.calls[0][0]).toMatchObject({
      query: { tags: [5, 42], query: 'cats' },
    });
  });

  test('Clear drops the tags from the URL and keeps the search', async () => {
    renderFeed();
    await openFilters();
    await page.getByRole('button', { name: 'Clear all filters' }).click();

    const { query } = vi.mocked(Router.replace).mock.calls[0][0] as { query: object };
    expect(query).toMatchObject({ query: 'cats' });
    expect(query).not.toHaveProperty('tags');
  });

  test('is not offered, and the URL tags are left alone, without showTags', async () => {
    renderFeed(false);
    await openFilters();
    await page.getByRole('radio', { name: 'Day' }).click();
    await page.getByRole('button', { name: 'Apply filters' }).click();

    expect(page.getByRole('button', { name: /^tags:/ }).query()).toBeNull();
    expect(Router.replace).not.toHaveBeenCalled();
  });
});
