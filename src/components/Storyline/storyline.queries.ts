import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useQueryImages } from '~/components/Image/image.utils';
import { getStorylinePathLanes } from '~/components/Storyline/storyline-lane-map.utils';
import {
  canonAheadForkStops,
  getPathImagesPaging,
  hideHiddenUsersChapters,
  orderPathImages,
} from '~/components/Storyline/storyline-mode.utils';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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

export function useStorylinePath(chapterId: number | undefined, via: number[] = []) {
  const enabled = useStorylinesEnabled();
  const browsingLevel = useViewerBrowsingLevelDebounced();
  return trpc.storyline.getPath.useQuery(
    { chapterId: chapterId as number, browsingLevel, ...(via.length ? { via } : {}) },
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

/**
 * The canon line after a chapter, in one read, with the ways off it for the stops that have
 * any (at most `STORYLINE_DRAWER_FORK_STOPS`, nearest first). `forks: false` skips those reads.
 */
export function useStorylineCanonAhead(
  chapterId: number | undefined,
  options: { enabled: boolean; forks?: boolean }
) {
  const enabled = useStorylinesEnabled() && options.enabled && !!chapterId;
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const hiddenUserIds = useHiddenUserIds();
  const query = trpc.storyline.getCanonAhead.useQuery(
    { chapterId: chapterId as number, browsingLevel },
    { enabled }
  );
  const ahead = useMemo(
    () => (query.data ? hideHiddenUsersChapters(query.data, hiddenUserIds) : []),
    [query.data, hiddenUserIds]
  );
  const forkStopIds = useMemo(
    () => canonAheadForkStops(query.data ?? [], STORYLINE_DRAWER_FORK_STOPS),
    [query.data]
  );
  const childrenByChapterId = useStorylinePathChildren(forkStopIds, {
    enabled: enabled && (options.forks ?? true),
  });
  const isLoading = enabled && query.isLoading;
  const isSuccess = enabled && query.isSuccess;
  return useMemo(
    () => ({ ahead, childrenByChapterId, isLoading, isSuccess }),
    [ahead, childrenByChapterId, isLoading, isSuccess]
  );
}

export function useStorylineGraph(id: number, options: { enabled: boolean }) {
  const enabled = useStorylinesEnabled() && options.enabled;
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const hiddenUserIds = useHiddenUserIds();
  const query = trpc.storyline.getGraph.useQuery({ id, browsingLevel }, { enabled });
  const data = useMemo(
    () =>
      query.data && {
        ...query.data,
        chapters: hideHiddenUsersChapters(query.data.chapters, hiddenUserIds),
      },
    [query.data, hiddenUserIds]
  );
  return { data, isLoading: enabled && query.isLoading };
}

/**
 * Reads the graph only when some chapter of the path is off the main route, so a reader on the main
 * route makes no request for it.
 */
export function useStorylinePathLanes(
  storylineId: number,
  path: { chapterId: number; onMain: boolean }[]
) {
  const offMain = path.some((chapter) => !chapter.onMain);
  const { data: graph } = useStorylineGraph(storylineId, { enabled: offMain });
  return useMemo(() => getStorylinePathLanes(graph, path), [graph, path]);
}

/** One children read per given chapter id, for the forks the drawer draws beside them. */
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unstable arrays; their keys stand in
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

export function useStorylineContinueTerms(parentPostId: number | undefined) {
  const enabled = useStorylinesEnabled() && !!parentPostId;
  const query = trpc.placement.getStorylineContinuePrice.useQuery(
    { parentPostId: parentPostId as number },
    { enabled, retry: false }
  );
  // A refused read reads as "no terms", not an error.
  return query.data ?? null;
}

/** Below `minChoices` choices, `enough` is false and `shares` is empty. */
export function useStorylineForkShares(chapterId: number | undefined) {
  const enabled = useStorylinesEnabled();
  const browsingLevel = useViewerBrowsingLevelDebounced();
  return trpc.storyline.getForkShares.useQuery(
    { chapterId: chapterId as number, browsingLevel },
    { enabled: enabled && !!chapterId }
  );
}

/** Signed-in readers only: the server refuses a signed-out choice, so none is sent. */
export function useStorylineTracking() {
  const currentUser = useCurrentUser();
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const utils = trpc.useUtils();
  const branchChoice = trpc.storyline.trackBranchChoice.useMutation({
    // The server writes the new count through to its cache before answering, so this read sees the
    // new choice.
    onSuccess: (_, { fromChapterId }) =>
      utils.storyline.getForkShares.invalidate({ chapterId: fromChapterId }),
  });
  const createClick = trpc.storyline.trackCreateClick.useMutation();
  return {
    trackBranchChoice: (input: { fromChapterId: number; toChapterId: number }) => {
      if (currentUser) branchChoice.mutate({ ...input, browsingLevel });
    },
    trackCreateClick: (input: { chapterId: number }) => {
      if (currentUser) createClick.mutate({ ...input, browsingLevel });
    },
  };
}

/** Signed out reads as not joined; joining needs an account. */
export function useStorylineEarlyAccess() {
  const currentUser = useCurrentUser();
  const enabled = useStorylinesEnabled() && !!currentUser;
  const utils = trpc.useUtils();
  const status = trpc.storyline.getEarlyAccessStatus.useQuery(undefined, { enabled });
  const mutation = trpc.storyline.joinEarlyAccess.useMutation({
    onSuccess: () => utils.storyline.getEarlyAccessStatus.setData(undefined, { joined: true }),
  });
  return {
    joined: enabled && !!status.data?.joined,
    join: async (input: { storylineId?: number }) => {
      await mutation.mutateAsync(input);
    },
    isJoining: mutation.isPending,
  };
}
