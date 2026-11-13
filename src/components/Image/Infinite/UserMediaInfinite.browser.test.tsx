import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useRouter } from 'next/router';
import type * as Trpc from '~/utils/trpc';
import { UserMediaInfinite } from '~/components/Image/Infinite/UserMediaInfinite';
import { MediaType } from '~/shared/utils/prisma/enums';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const state = vi.hoisted(() => ({
  availability: { isModerator: false, canViewNsfw: false, showNsfw: false },
  feedFilters: undefined as Record<string, unknown> | undefined,
  hideCreator: undefined as boolean | undefined,
  profileLookups: [] as unknown[],
  viewer: null as { id: number; username: string } | null,
}));

vi.mock('~/components/Filters/useSortAvailability', () => ({
  useSortAvailability: () => state.availability,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.viewer }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    // Like the database: the account is found by its name as stored (case-insensitively).
    'userProfile.get': {
      useQuery: (input: { username: string }) => {
        state.profileLookups.push(input);
        const found = ['alice', 'foo-bar', '山田'].includes(input.username.toLowerCase());
        return { data: found ? { id: 7 } : undefined, isLoading: false };
      },
    },
  }),
}));
// Capture what the feed would query with; the feed's own fetching is not under test.
vi.mock('~/components/Image/Infinite/ImagesInfinite', () => ({
  default: (props: { filters: Record<string, unknown>; hideCreator?: boolean }) => {
    state.feedFilters = props.filters;
    state.hideCreator = props.hideCreator;
    return null;
  },
}));
vi.mock('~/components/Image/Filters/MediaFiltersDropdown', () => ({
  MediaFiltersDropdown: () => null,
}));

describe('UserMediaInfinite sort', () => {
  beforeEach(() => {
    state.feedFilters = undefined;
    // The profile is opened on the URL; the router stub's query is the URL.
    useRouter().query = { username: 'alice', sort: 'Newest' };
    state.availability = { isModerator: false, canViewNsfw: false, showNsfw: false };
  });

  test('a viewer who may not sort by Newest sees, and queries, Most Reactions', async () => {
    renderWithProviders(<UserMediaInfinite type={MediaType.image} />);

    await expect.element(page.getByText('Most Reactions')).toBeVisible();
    expect(state.feedFilters?.sort).toBe('Most Reactions');
  });

  test('a viewer who may browse NSFW keeps Newest in both', async () => {
    state.availability = { isModerator: false, canViewNsfw: true, showNsfw: true };
    renderWithProviders(<UserMediaInfinite type={MediaType.image} />);

    await expect.element(page.getByText('Newest')).toBeVisible();
    expect(state.feedFilters?.sort).toBe('Newest');
  });
});

describe('UserMediaInfinite profile scope', () => {
  beforeEach(() => {
    state.feedFilters = undefined;
    state.hideCreator = undefined;
    useRouter().query = { username: 'alice' };
    state.profileLookups = [];
    state.viewer = null;
    state.availability = { isModerator: false, canViewNsfw: false, showNsfw: false };
  });

  // Older usernames may hold a '-', space or non-ASCII; their slug ('foobar', or '' for '山田')
  // names no account, and a lookup by it leaves the tab on "No results" or NotFound.
  test.each(['alice', 'foo-bar', '山田'])(
    'the %s profile lists its own account',
    async (username) => {
      useRouter().query = { username };
      renderWithProviders(<UserMediaInfinite type={MediaType.image} />);

      await expect.poll(() => state.profileLookups).toContainEqual({ username });
      await expect.poll(() => state.feedFilters?.userId).toBe(7);
    }
  );

  test('the owner of a profile whose username is not its slug gets the owner toggle', async () => {
    useRouter().query = { username: 'foo-bar' };
    state.viewer = { id: 7, username: 'foo-bar' };
    renderWithProviders(<UserMediaInfinite type={MediaType.image} />);

    await expect.element(page.getByText('My Reactions')).toBeVisible();
  });

  test.each([MediaType.image, MediaType.video])(
    'hides repeated creators only on the %s tab',
    async (type) => {
      state.viewer = { id: 7, username: 'alice' };
      const screen = await renderWithProviders(<UserMediaInfinite type={type} />);
      await expect.poll(() => state.hideCreator).toBe(true);
      useRouter().query = { username: 'alice', section: 'reactions' };
      await screen.rerender(<UserMediaInfinite type={type} />);
      await expect.poll(() => state.hideCreator).toBe(false);
    }
  );

  test('a viewer whose name has the same slug does not', async () => {
    useRouter().query = { username: 'foo-bar' };
    // Not the owner (id 7), though `postgresSlugify` makes both names 'foobar'.
    state.viewer = { id: 8, username: 'foobar' };
    renderWithProviders(<UserMediaInfinite type={MediaType.image} />);

    await expect.poll(() => state.feedFilters?.userId).toBe(7);
    expect(page.getByText('My Reactions').elements()).toHaveLength(0);
  });
});
