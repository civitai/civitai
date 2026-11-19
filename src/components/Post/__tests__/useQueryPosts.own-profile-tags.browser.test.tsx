import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as BrowsingLevelMod from '~/components/BrowsingLevel/BrowsingLevelProvider';

/**
 * On your own profile the posts feed skips your excluded-tag preferences. A profile now names
 * its account by `userId`, so the skip has to recognise you by id too.
 */

const state = vi.hoisted(() => ({
  viewer: null as { id: number; username: string } | null,
  sent: undefined as { excludedTagIds?: number[] } | undefined,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'post.getInfinite': {
        useInfiniteQuery: (input: { excludedTagIds?: number[] }) => {
          state.sent = input;
          return { data: undefined, isLoading: false, isRefetching: false };
        },
      },
    }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.viewer }));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', () => ({
  useBrowsingSettingsAddons: () => ({ settings: { excludedTagIds: [99] } }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (orig) => ({
  ...(await orig<typeof BrowsingLevelMod>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: () => ({ items: [], loadingPreferences: false }),
}));

// eslint-disable-next-line import/first
import { useQueryPosts } from '~/components/Post/post.utils';

function Feed() {
  useQueryPosts({ userId: 42 });
  return null;
}

beforeEach(() => {
  state.sent = undefined;
});

describe('excluded tags on a profile scoped by userId', () => {
  test('the owner sees their own posts unfiltered', async () => {
    state.viewer = { id: 42, username: 'foo-bar' };
    renderWithProviders(<Feed />);

    await expect.poll(() => state.sent?.excludedTagIds).toEqual([]);
  });

  test('anyone else keeps their excluded tags', async () => {
    state.viewer = { id: 7, username: 'foobar' };
    renderWithProviders(<Feed />);

    await expect.poll(() => state.sent?.excludedTagIds).toEqual([99]);
  });
});
