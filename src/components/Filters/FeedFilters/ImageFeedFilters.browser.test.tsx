import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import Router from 'next/router';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import { ImageFeedFilters } from '~/components/Filters/FeedFilters/ImageFeedFilters';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const flags = vi.hoisted(() => ({ value: {} as Record<string, boolean> }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => flags.value,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
// Needs the page's container providers; the sort menu is what is under test.
vi.mock('~/components/Image/Filters/MediaFiltersDropdown', () => ({
  MediaFiltersDropdown: () => null,
}));

// The mocked router is one singleton: the default export is what `useRouter()` returns.
const router = vi.mocked(Router);
const lastReplaceQuery = () =>
  (router.replace.mock.lastCall?.[0] as { query: Record<string, unknown> }).query;

describe('ImageFeedFilters sort while searching', () => {
  beforeEach(() => {
    flags.value = { feedSearch: true, imageSearchNewestSort: true };
    router.replace.mockClear();
  });

  test('picking Newest puts searchSort=newest on the URL', async () => {
    router.query = { query: 'red dragon' };
    renderWithProviders(<ImageFeedFilters />);

    await page.getByText('Best match').click();
    await page.getByText('Newest').click();

    expect(lastReplaceQuery()).toEqual({ query: 'red dragon', searchSort: 'newest' });
  });

  test('picking Best match takes searchSort off the URL', async () => {
    router.query = { query: 'red dragon', searchSort: 'newest' };
    renderWithProviders(<ImageFeedFilters />);

    await page.getByText('Newest').click();
    await page.getByText('Best match').click();

    expect(lastReplaceQuery()).toEqual({ query: 'red dragon' });
  });

  test('without the flag the sort stays locked on Best match', async () => {
    flags.value = { feedSearch: true };
    router.query = { query: 'red dragon', searchSort: 'newest' };
    renderWithProviders(<ImageFeedFilters />);

    await expect.element(page.getByRole('button', { name: 'Best match' })).toBeDisabled();
    expect(page.getByText('Newest').query()).toBeNull();
  });
});
