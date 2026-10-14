// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowsingLevelModule from '~/components/BrowsingLevel/BrowsingLevelProvider';

const mocks = vi.hoisted(() => ({
  storylines: true,
  getForPosts: vi.fn(),
  byPost: {} as Record<
    number,
    { chapterId: number; depth: number; storylineId: number; title: string }
  >,
}));

// Records every storyline read the provider asks for: that count, per feed page, is what the
// pill must hold constant however many cards the page has.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      {},
      {
        useQueries: (
          build: (t: {
            storyline: { getForPosts: (input: { postIds: number[] }) => unknown };
          }) => unknown[]
        ) =>
          build({
            storyline: {
              getForPosts: (input) => {
                mocks.getForPosts(input);
                return input;
              },
            },
          }).map(() => ({ data: mocks.byPost, dataUpdatedAt: 1 })),
      }
    ),
  };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ storylines: mocks.storylines }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelModule>()),
  useViewerBrowsingLevelDebounced: () => 1,
}));

import {
  StorylineBatchProvider,
  useStorylineForPost,
} from '~/components/Storyline/StorylineBatchProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seen: Record<number, string | null> = {};
function Card({ postId }: { postId: number }) {
  const entry = useStorylineForPost(postId);
  seen[postId] = entry ? `${entry.title} ch ${entry.depth + 1}` : null;
  return null;
}

function renderFeed(postIds: number[]) {
  const container = document.createElement('div');
  act(() => {
    createRoot(container).render(
      createElement(
        StorylineBatchProvider,
        { postIds },
        postIds.map((postId) => createElement(Card, { key: postId, postId }))
      )
    );
  });
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

describe('StorylineBatchProvider', () => {
  beforeEach(() => {
    mocks.storylines = true;
    mocks.getForPosts.mockClear();
    mocks.byPost = {};
    for (const key of Object.keys(seen)) delete seen[Number(key)];
  });

  it('reads storyline membership for a 50-card page in ONE request, not one per card', () => {
    renderFeed(range(1, 50));
    expect(mocks.getForPosts).toHaveBeenCalledTimes(1);
    expect(mocks.getForPosts.mock.calls[0][0].postIds).toHaveLength(50);
  });

  it('grows by chunks of 100 posts, not by cards', () => {
    renderFeed(range(1, 250));
    expect(mocks.getForPosts.mock.calls.map(([input]) => input.postIds.length)).toEqual([
      100, 100, 50,
    ]);
  });

  it('reads nothing at all with the flag off', () => {
    mocks.storylines = false;
    renderFeed(range(1, 50));
    expect(mocks.getForPosts).not.toHaveBeenCalled();
    expect(seen[1]).toBeNull();
  });

  it('gives each card its own post’s entry and nothing to a post outside a storyline', () => {
    mocks.byPost = { 2: { chapterId: 20, depth: 2, storylineId: 5, title: 'The Patch' } };
    renderFeed([1, 2, 3]);
    expect(seen).toEqual({ 1: null, 2: 'The Patch ch 3', 3: null });
  });
});
