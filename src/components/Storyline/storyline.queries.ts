import { keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useQueryImages } from '~/components/Image/image.utils';
import { orderPathImages } from '~/components/Storyline/storyline-mode.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { StorylinePathChapter } from '~/server/services/storyline.service';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';

export type StorylinePath = RouterOutput['storyline']['getPath'];
export type StorylineChild = RouterOutput['storyline']['getChildren'][number];
export type StorylineForPost = RouterOutput['storyline']['getForPosts'][number];
export type { StorylinePathChapter };

/** Matches the `postIds` cap on `getStorylinesForPostsSchema`. */
export const STORYLINE_POSTS_CHUNK = 100;
/** Matches the `limit` cap on the image feed schema. */
const PATH_IMAGES_LIMIT = 200;

export function useStorylinesEnabled() {
  return !!useFeatureFlags().storylines;
}

export function useStorylinePath(chapterId: number | undefined) {
  const enabled = useStorylinesEnabled();
  const browsingLevel = useViewerBrowsingLevelDebounced();
  return trpc.storyline.getPath.useQuery(
    { chapterId: chapterId as number, browsingLevel },
    { enabled: enabled && !!chapterId, placeholderData: keepPreviousData }
  );
}

export function useStorylineChildren(
  chapterId: number | undefined,
  options?: { enabled?: boolean }
) {
  const enabled = useStorylinesEnabled() && (options?.enabled ?? true);
  const browsingLevel = useViewerBrowsingLevelDebounced();
  return trpc.storyline.getChildren.useQuery(
    { chapterId: chapterId as number, browsingLevel },
    { enabled: enabled && !!chapterId }
  );
}

/** One children read per chapter on the path, for the forks the drawer draws beside it. */
export function useStorylinePathChildren(chapterIds: number[], options: { enabled: boolean }) {
  const enabled = useStorylinesEnabled() && options.enabled;
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const queries = trpc.useQueries((t) =>
    (enabled ? chapterIds : []).map((chapterId) =>
      t.storyline.getChildren({ chapterId, browsingLevel })
    )
  );
  return useMemo(() => {
    const byChapterId = new Map<number, StorylineChild[]>();
    queries.forEach((query, i) => {
      if (query.data) byChapterId.set(chapterIds[i], query.data);
    });
    return byChapterId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterIds.join(','), queries.map((q) => q.dataUpdatedAt).join(',')]);
}

/**
 * The images of every visible chapter on a path, in reading order: chapter by chapter, then by
 * each post's own image order. A tombstoned chapter has no post, so it contributes nothing and
 * the walk passes over it.
 */
export function useStorylinePathImages(chapters: StorylinePathChapter[] | undefined) {
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const postIds = useMemo(
    () => (chapters ?? []).flatMap((c) => (c.post ? [c.post.id] : [])),
    [chapters]
  );
  const { images, isLoading, isFetching } = useQueryImages(
    { postIds, browsingLevel, limit: PATH_IMAGES_LIMIT },
    { enabled: postIds.length > 0, keepPreviousData: true }
  );
  const ordered = useMemo(() => orderPathImages(images, postIds), [images, postIds]);
  return { images: ordered, isLoading: postIds.length > 0 && isLoading, isFetching };
}

// The procedures below are owned by the storyline services and are not on the router yet; these
// keep the viewer's call sites final so swapping each one in is a one-line change.

export type StorylineForkShares = { total: number | null; shares: Record<number, number> };
const NO_SHARES: StorylineForkShares = { total: null, shares: {} };

export function useStorylineForkShares(_chapterId: number | undefined) {
  return { data: NO_SHARES };
}

export function useStorylineTracking() {
  return {
    trackBranchChoice: (_input: { fromChapterId: number; toChapterId: number }) => undefined,
    trackCreateClick: (_input: { chapterId: number }) => undefined,
  };
}

export function useStorylineEarlyAccess() {
  return {
    joined: false,
    join: async (_input: { storylineId?: number }) => undefined,
    isJoining: false,
  };
}
