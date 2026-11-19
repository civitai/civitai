import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';

/**
 * The Posts and Articles profile tabs name the account by id. Older usernames such as 'foo-bar'
 * slugify to 'foobar', which names no account, and whose slug a different account can share.
 */

const state = vi.hoisted(() => ({
  viewer: null as { id: number; username: string; isModerator: boolean } | null,
  postFilters: undefined as Record<string, unknown> | undefined,
  articleFilters: undefined as Record<string, unknown> | undefined,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      // Like the database: the account is found by its name as stored.
      'userProfile.get': {
        useQuery: (input: { username: string }) => ({
          data: input.username === 'foo-bar' ? { id: 42 } : undefined,
          isLoading: false,
        }),
      },
    }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.viewer }));
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));
vi.mock('~/server/services/user-banned-at.service', () => ({
  getUserBannedAtByUsername: async () => null,
}));
vi.mock('~/components/Profile/ProfileLayout2', () => ({ UserProfileLayout: undefined }));
vi.mock('~/components/Post/Infinite/PostsInfinite', () => ({
  default: (props: { filters: Record<string, unknown> }) => {
    state.postFilters = props.filters;
    return null;
  },
}));
vi.mock('~/components/AppLayout/NotFound', () => ({ NotFound: () => <span>not found</span> }));
vi.mock('~/components/Filters', () => ({ SortFilter: () => <span>sort menu</span> }));
vi.mock('~/components/Post/Infinite/PostFiltersDropdown', () => ({
  PostFiltersDropdown: () => null,
}));
vi.mock('~/components/Article/Infinite/ArticlesInfinite', () => ({
  ArticlesInfinite: (props: { filters: Record<string, unknown> }) => {
    state.articleFilters = props.filters;
    return null;
  },
}));
vi.mock('~/components/Article/UserDraftArticles', () => ({ UserDraftArticles: () => null }));
vi.mock('~/components/Article/Infinite/ArticleFiltersDropdown', () => ({
  ArticleFiltersDropdown: () => null,
}));

// eslint-disable-next-line import/first
import UserPostsPage from '~/pages/user/[username]/posts';
// eslint-disable-next-line import/first
import UserArticlesPage from '~/pages/user/[username]/articles';

// The scaffold mocks next/router; this is its shared object, not a hook call.
// eslint-disable-next-line react-hooks/rules-of-hooks
const router = useRouter();

const owner = { id: 42, username: 'foo-bar', isModerator: false };
// Not the owner, though `postgresSlugify` makes both names 'foobar'.
const lookalike = { id: 7, username: 'foobar', isModerator: false };

beforeEach(() => {
  router.query = { username: 'foo-bar' };
  state.viewer = null;
  state.postFilters = undefined;
  state.articleFilters = undefined;
});

describe('a profile whose username is not its slug', () => {
  test('the Posts tab lists that account, signed out', async () => {
    renderWithProviders(<UserPostsPage />);

    await expect.poll(() => state.postFilters?.userId).toBe(42);
  });

  // Already right before the id change: the articles query takes the name as stored, which the
  // case-insensitive username column matches. Pinned so a slugify there is noticed.
  test('the Articles tab lists that account by its name as stored', async () => {
    renderWithProviders(<UserArticlesPage />);

    await expect.poll(() => state.articleFilters?.username).toBe('foo-bar');
  });

  test.each([
    ['Posts', UserPostsPage],
    ['Articles', UserArticlesPage],
  ])('%s: a username with no account is not found', async (_tab, Tab) => {
    router.query = { username: 'nobody' };
    renderWithProviders(<Tab />);

    await expect.element(page.getByText('not found')).toBeVisible();
  });

  test.each([
    ['Posts', UserPostsPage],
    ['Articles', UserArticlesPage],
  ])('%s: the owner gets the drafts toggle', async (_tab, Tab) => {
    state.viewer = owner;
    renderWithProviders(<Tab />);

    await expect.element(page.getByText('Draft')).toBeVisible();
  });

  test.each([
    ['Posts', UserPostsPage],
    ['Articles', UserArticlesPage],
  ])('%s: a viewer whose name has the same slug does not', async (_tab, Tab) => {
    state.viewer = lookalike;
    renderWithProviders(<Tab />);

    // The tab rendered (its sort menu is up) before the toggle's absence means anything.
    await expect.element(page.getByText('sort menu')).toBeVisible();
    expect(page.getByText('Draft').elements()).toHaveLength(0);
  });
});
