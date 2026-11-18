import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import Router from 'next/router';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import { ImageFeedFilters } from '~/components/Filters/FeedFilters/ImageFeedFilters';
import { FiltersProvider } from '~/providers/FiltersProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const flags = vi.hoisted(() => ({ value: {} as Record<string, boolean> }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => flags.value,
}));
const currentUser = vi.hoisted(() => ({ value: null as { id: number } | null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => currentUser.value }));
// Needs the page's container providers; the sort menu is what is under test.
vi.mock('~/components/Image/Filters/MediaFiltersDropdown', () => ({
  MediaFiltersDropdown: () => null,
}));

// FollowedFilter reads the filters store the app mounts above the page.
const renderFilters = () =>
  renderWithProviders(
    <FiltersProvider>
      <ImageFeedFilters />
    </FiltersProvider>
  );

// The mocked router is one singleton: the default export is what `useRouter()` returns.
const router = vi.mocked(Router);
const lastReplaceQuery = () => {
  expect(router.replace).toHaveBeenCalledTimes(1);
  return (router.replace.mock.lastCall?.[0] as { query: Record<string, unknown> }).query;
};

describe('ImageFeedFilters sort while searching', () => {
  beforeEach(() => {
    flags.value = { feedSearch: true, imageSearchNewestSort: true };
    currentUser.value = null;
    router.replace.mockClear();
  });

  test('picking Newest matches puts searchSort=newest on the URL', async () => {
    router.query = { query: 'red dragon' };
    renderFilters();

    await page.getByText('Best match').click();
    await page.getByText('Newest matches').click();

    expect(lastReplaceQuery()).toEqual({ query: 'red dragon', searchSort: 'newest' });
  });

  test('picking Best match takes searchSort off the URL', async () => {
    router.query = { query: 'red dragon', searchSort: 'newest' };
    renderFilters();

    await page.getByText('Newest matches').click();
    await page.getByText('Best match').click();

    expect(lastReplaceQuery()).toEqual({ query: 'red dragon' });
  });

  test('without the flag the sort stays locked on Best match', async () => {
    flags.value = { feedSearch: true };
    router.query = { query: 'red dragon', searchSort: 'newest' };
    renderFilters();

    await expect.element(page.getByRole('button', { name: 'Best match' })).toBeDisabled();
    expect(page.getByText('Newest matches').query()).toBeNull();
  });

  // A tap is a click with no mouse hover before it. That it lands on the wrapper, not the disabled
  // button, needs the real stylesheet: SearchSortLock.geometry.test.tsx.
  async function tapLock(name: string) {
    const button = page.getByRole('button', { name });
    await expect.element(button).toBeDisabled();
    (button.element().parentElement as HTMLElement).click();
  }

  test('tapping the locked sort says why it is locked, and a tap elsewhere closes it', async () => {
    flags.value = { feedSearch: true, moreLikeThis: true };
    router.query = { similarTo: '123' };
    renderFilters();
    const reason = page.getByText('Clear the search to sort the feed');

    await tapLock('Best match');
    await expect.element(reason).toBeVisible();

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await expect.element(reason).not.toBeInTheDocument();
  });

  test('the locked sort shows no reason until tapped', async () => {
    flags.value = { feedSearch: true, moreLikeThis: true };
    router.query = { similarTo: '123' };
    renderFilters();

    await expect.element(page.getByRole('button', { name: 'Best match' })).toBeDisabled();
    expect(page.getByText('Clear the search to sort the feed').query()).toBeNull();
  });

  test('tapping the locked audience says why it is locked', async () => {
    flags.value = { feedSearch: true, moreLikeThis: true };
    currentUser.value = { id: 1 };
    router.query = { similarTo: '123' };
    renderFilters();

    await tapLock('Everyone');
    await expect.element(page.getByText('Clear the search to filter by who posted')).toBeVisible();
  });

  test.each([
    { saved: 'Followed', audience: { followed: 'true' } },
    { saved: 'New & Upcoming', audience: { newCreators: 'true' } },
  ])(
    'the locked audience reads Everyone even when the feed is set to $saved',
    async ({ saved, audience }) => {
      flags.value = { feedSearch: true };
      currentUser.value = { id: 1 };
      router.query = { query: 'red dragon', ...audience };
      renderFilters();

      await expect.element(page.getByRole('button', { name: 'Everyone' })).toBeDisabled();
      expect(page.getByRole('button', { name: saved }).query()).toBeNull();
    }
  );
});
