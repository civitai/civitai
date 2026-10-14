import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useQueryImages } from '~/components/Image/image.utils';
import {
  getPathImagesPaging,
  hideHiddenUsersChapters,
  orderPathImages,
} from '~/components/Storyline/storyline-mode.utils';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
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
const PATH_IMAGES_MAX_PAGES = 10;

export function useStorylinesEnabled() {
  return !!useFeatureFlags().storylines;
}

export function useHiddenUserIds() {
  const hiddenUsers = useHiddenPreferencesData()?.hiddenUsers;
  return useMemo(() => new Set((hiddenUsers ?? []).map((u) => u.id)), [hiddenUsers]);
}

/** The drawer reads forks for the stops nearest the end only, so a long path is not N reads. */
export const STORYLINE_DRAWER_FORK_STOPS = 10;

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
  const hiddenUserIds = useHiddenUserIds();
  const query = trpc.storyline.getChildren.useQuery(
    { chapterId: chapterId as number, browsingLevel },
    { enabled: enabled && !!chapterId }
  );
  const data = useMemo(
    () => query.data && hideHiddenUsersChapters(query.data, hiddenUserIds),
    [query.data, hiddenUserIds]
  );
  return { data, isLoading: query.isLoading };
}

/** One children read per chapter on the path, for the forks the drawer draws beside it. */
export function useStorylinePathChildren(chapterIds: number[], options: { enabled: boolean }) {
  const enabled = useStorylinesEnabled() && options.enabled;
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const hiddenUserIds = useHiddenUserIds();
  const queries = trpc.useQueries((t) =>
    (enabled ? chapterIds : []).map((chapterId) =>
      t.storyline.getChildren({ chapterId, browsingLevel })
    )
  );
  return useMemo(() => {
    const byChapterId = new Map<number, StorylineChild[]>();
    queries.forEach((query, i) => {
      if (query.data)
        byChapterId.set(chapterIds[i], hideHiddenUsersChapters(query.data, hiddenUserIds));
    });
    return byChapterId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterIds.join(','), hiddenUserIds, queries.map((q) => q.dataUpdatedAt).join(',')]);
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
  const { images, data, isLoading, isFetching, isError, hasNextPage, fetchNextPage } =
    useQueryImages(
      { postIds, browsingLevel, limit: PATH_IMAGES_LIMIT },
      { enabled: postIds.length > 0, keepPreviousData: true }
    );
  const pages = data?.pages.length ?? 0;
  const paging = getPathImagesPaging({
    hasNextPage: !!hasNextPage,
    isFetching,
    isError,
    pages,
    maxPages: PATH_IMAGES_MAX_PAGES,
  });
  useEffect(() => {
    if (paging.fetchNext) fetchNextPage();
  }, [paging.fetchNext, fetchNextPage]);
  const ordered = useMemo(() => orderPathImages(images, postIds), [images, postIds]);
  return {
    images: ordered,
    isLoading: postIds.length > 0 && isLoading,
    isFetching: paging.loading,
  };
}

// The procedures below are owned by the storyline services and are not on the router yet; these
// keep the viewer's call sites final so swapping each one in is a one-line change.

/** Below `minChoices` choices, `enough` is false and `shares` is empty. */
export type StorylineForkShares = {
  enough: boolean;
  total: number;
  minChoices: number;
  shares: Record<number, number>;
};
const NO_SHARES: StorylineForkShares = { enough: false, total: 0, minChoices: 20, shares: {} };

export function useStorylineForkShares(chapterId: number | undefined) {
  return { data: chapterId ? NO_SHARES : undefined };
}

export function useStorylineTracking() {
  return {
    /** Once real: invalidate `getForkShares` for `fromChapterId` when it resolves. */
    trackBranchChoice: (input: { fromChapterId: number; toChapterId: number }) => {
      void input;
    },
    trackCreateClick: (input: { chapterId: number }) => {
      void input;
    },
  };
}

export function useStorylineEarlyAccess() {
  return {
    joined: false,
    join: async (input: { storylineId?: number }) => {
      void input;
    },
    isJoining: false,
  };
}
