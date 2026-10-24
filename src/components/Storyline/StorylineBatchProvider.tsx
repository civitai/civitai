import { createContext, useContext, useMemo } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type { StorylineForPost } from '~/components/Storyline/storyline.queries';
import {
  STORYLINE_POSTS_CHUNK,
  useStorylinesEnabled,
} from '~/components/Storyline/storyline.queries';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

const StorylineBatchContext = createContext<Record<number, StorylineForPost> | null>(null);

/**
 * Storyline membership for every post on a surface, so a card can wear the storyline pill without
 * a read of its own: one request per chunk of posts, chunked in arrival order so an appended feed
 * page leaves earlier chunks' keys alone.
 */
export function StorylineBatchProvider({
  postIds,
  children,
}: {
  postIds: number[];
  children: React.ReactNode;
}) {
  const enabled = useStorylinesEnabled();
  const browsingLevel = useViewerBrowsingLevelDebounced();

  const chunks = useMemo(
    () => (enabled ? chunkIds(postIds, STORYLINE_POSTS_CHUNK) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unstable array; its join is the key
    [postIds.join(','), enabled]
  );

  const queries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.storyline.getForPosts({ postIds: chunk, browsingLevel }, { staleTime: 60_000 })
    )
  );

  const byPost = useMemo(
    () => Object.assign({}, ...queries.map((query) => query.data ?? {})),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queries unstable; stamps are the key
    [queries.map((query) => query.dataUpdatedAt).join(',')]
  ) as Record<number, StorylineForPost>;

  if (!enabled) return <>{children}</>;

  return <StorylineBatchContext.Provider value={byPost}>{children}</StorylineBatchContext.Provider>;
}

/** No per-card fallback read: a surface without the provider shows no pill. */
export function useStorylineForPost(postId: number | null | undefined) {
  const byPost = useContext(StorylineBatchContext);
  if (!byPost || postId == null) return null;
  return byPost[postId] ?? null;
}
