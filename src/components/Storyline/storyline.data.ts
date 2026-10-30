import type { StorylineSubmitOutcome } from '~/components/Storyline/continue/StorylineContinueForm';
import type { StorylineSpaceSettings } from '~/components/Storyline/manage/StorylineSettingsForm';
import type { StorylineQueueRow } from '~/components/Storyline/queue/StorylineQueueList';
import { useDebouncedValue } from '@mantine/hooks';
import { useMemo, useState } from 'react';
import type { StorylineClosedReason } from '~/components/Storyline/storyline-ui';
import {
  STORYLINE_CONTINUE_POST_LIMIT,
  storylineContinuePostOptions,
  storylineWithoutChapters,
} from '~/components/Storyline/storyline-ui';
import { isPublished } from '~/components/Storyline/storyline.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { PostSort } from '~/server/common/enums';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The storyline placement procedures answer `notAvailable` when the feature is off for the viewer.
 * That is a state of the feature, not a failure, so the UI says "not available yet" for it rather
 * than an error.
 */
export const isStorylineNotAvailable = (error: { message: string } | null | undefined) =>
  error?.message === STORYLINE_REFUSALS.notAvailable;

const showError = (title: string) => (error: { message: string }) =>
  showErrorNotification({ title, error: new Error(error.message) });

export function useStorylineSpace(
  storylineId: number,
  { enabled }: { enabled: boolean }
): {
  data: StorylineSpaceSettings | null;
  unavailable: boolean;
  isSaving: boolean;
  save: (price: number | null) => void;
} {
  const utils = trpc.useUtils();
  const query = trpc.placement.getStorylineSpace.useQuery(
    { storylineId },
    { enabled, retry: false }
  );
  const mutation = trpc.placement.setStorylineSpace.useMutation({
    onSuccess: (space) => utils.placement.getStorylineSpace.setData({ storylineId }, space),
    onError: showError("Couldn't save the price"),
  });

  // Withheld while re-reading: a save sends the mode it read, and a mode from before a status change
  // is the one value it must not send.
  const space = query.isFetching ? undefined : query.data;
  return {
    data: space ? { setPrice: space.setPrice, price: space.price, cap: space.cap } : null,
    unavailable: isStorylineNotAvailable(query.error),
    isSaving: mutation.isPending,
    // The write requires a mode; a price change carries the stored one so it never changes who
    // may submit.
    save: (price) => {
      if (space) mutation.mutate({ storylineId, mode: space.mode, price });
    },
  };
}

export function useStorylineContinueTerms(
  parentPostId: number,
  { enabled }: { enabled: boolean }
): {
  data: { open: boolean; price: number; closedReason: StorylineClosedReason | null } | null;
  unavailable: boolean;
  isLoading: boolean;
} {
  const query = trpc.placement.getStorylineContinuePrice.useQuery(
    { parentPostId },
    { enabled, retry: false }
  );
  return {
    data: query.data ?? null,
    unavailable: isStorylineNotAvailable(query.error),
    isLoading: enabled && query.isLoading,
  };
}

/**
 * Submit returns only the new placement's id, so the outcome is read back from the contributor's
 * own list: an endorsed collaborator's continuation is approved at once, anyone else's is pending.
 */
export function useSubmitStorylineContinuation({
  onSuccess,
}: {
  onSuccess: (outcome: StorylineSubmitOutcome) => void;
}): {
  isPending: boolean;
  error: string | null;
  mutate: (input: {
    parentPostId: number;
    postId: number;
    expectedPrice: number;
    awaitingScan: boolean;
  }) => void;
} {
  const utils = trpc.useUtils();
  const mutation = trpc.placement.submitStorylineContinuation.useMutation();
  return {
    isPending: mutation.isPending,
    error: mutation.error?.message ?? null,
    mutate: ({ awaitingScan, ...input }) =>
      mutation.mutate(input, {
        onSuccess: async ({ id }) => {
          onSuccess(
            await readSubmitOutcome(id, awaitingScan, () =>
              utils.client.placement.getMyStorylineContinuations.query({})
            )
          );
          utils.placement.getStorylineContinuePrice.invalidate({
            parentPostId: input.parentPostId,
          });
        },
        // The refusal names the new price; re-read it so the dialog shows what would be charged.
        onError: (error) => {
          if (error.message.startsWith(STORYLINE_REFUSALS.priceChanged))
            utils.placement.getStorylineContinuePrice.invalidate({
              parentPostId: input.parentPostId,
            });
        },
      }),
  };
}

export function useAddOwnerStorylineChapter({ onSuccess }: { onSuccess: () => void }): {
  isPending: boolean;
  error: string | null;
  mutate: (input: { parentChapterId: number; postId: number }) => void;
} {
  const utils = trpc.useUtils();
  const mutation = trpc.storyline.addChapter.useMutation();
  return {
    isPending: mutation.isPending,
    error: mutation.error?.message ?? null,
    mutate: (input) =>
      mutation.mutate(input, {
        onSuccess: () => {
          void utils.storyline.invalidate();
          onSuccess();
        },
      }),
  };
}

export function useInsertStorylineChapter({ onSuccess }: { onSuccess: () => void }): {
  isPending: boolean;
  error: string | null;
  mutate: (input: {
    storylineId: number;
    parentChapterId: number;
    childChapterId: number;
    postId: number;
  }) => void;
} {
  const utils = trpc.useUtils();
  const mutation = trpc.storyline.insertChapter.useMutation();
  return {
    isPending: mutation.isPending,
    error: mutation.error?.message ?? null,
    mutate: (input) =>
      mutation.mutate(input, {
        onSuccess: () => {
          void utils.storyline.invalidate();
          onSuccess();
        },
      }),
  };
}

export function useMoveStorylineChapter(): {
  isPending: boolean;
  error: string | null;
  mutate: (input: { storylineId: number; chapterId: number; afterChapterId: number }) => void;
} {
  const utils = trpc.useUtils();
  const mutation = trpc.storyline.moveChapter.useMutation();
  return {
    isPending: mutation.isPending,
    error: mutation.error?.message ?? null,
    mutate: (input) =>
      mutation.mutate(input, { onSuccess: () => void utils.storyline.invalidate() }),
  };
}

export function useLinkStorylineChapter({ onSuccess }: { onSuccess: () => void }): {
  isPending: boolean;
  error: string | null;
  mutate: (input: { parentChapterId: number; chapterId: number }) => void;
} {
  const utils = trpc.useUtils();
  const mutation = trpc.storyline.linkChapter.useMutation();
  return {
    isPending: mutation.isPending,
    error: mutation.error?.message ?? null,
    mutate: (input) =>
      mutation.mutate(input, {
        onSuccess: () => {
          void utils.storyline.invalidate();
          onSuccess();
        },
      }),
  };
}

export function useStorylineQueue({ enabled }: { enabled: boolean }): {
  unavailable: boolean;
  rows: StorylineQueueRow[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
} {
  const query = trpc.placement.getPendingStorylineContinuations.useInfiniteQuery(
    {},
    { enabled, retry: false, getNextPageParam: (page) => page.nextCursor ?? undefined }
  );
  const unavailable = isStorylineNotAvailable(query.error);
  return {
    unavailable,
    rows: query.data?.pages.flatMap((page) => page.items) ?? [],
    isLoading: query.isLoading,
    isError: query.isError && !unavailable,
    hasMore: !!query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

/** Rejects with the server's message on refusal. */
export function useActOnStorylineContinuation(): {
  act: (input: { placementId: number; action: 'approve' | 'decline' }) => Promise<void>;
} {
  const mutation = trpc.placement.actOnStorylineContinuation.useMutation();
  return {
    act: async (input) => {
      await mutation.mutateAsync(input);
    },
  };
}

export async function readSubmitOutcome(
  id: number,
  awaitingScan: boolean,
  readMine: () => Promise<{ items: { id: number; status: string; awaitingReadiness: boolean }[] }>
): Promise<StorylineSubmitOutcome> {
  const fallback = awaitingScan ? 'awaitingScan' : 'pending';
  try {
    const row = (await readMine()).items.find((item) => item.id === id);
    if (!row) return fallback;
    if (row.status === 'approved') return 'approved';
    return row.awaitingReadiness ? 'awaitingScan' : 'pending';
  } catch {
    return fallback;
  }
}

/** Chapter ratings, for the owner's ceiling picker. Owner and moderators only. */
export function useStorylineChapterLevels(storylineId: number, { enabled }: { enabled: boolean }) {
  const query = trpc.storyline.getChapterLevels.useQuery({ id: storylineId }, { enabled });
  return query.data ?? null;
}

/** Search and paging for a chapter picker's posts. */
export type StorylinePostPaging = {
  search: string;
  onSearchChange: (search: string) => void;
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
};

/**
 * The viewer's posts that are not chapters yet, newest first, for a chapter picker: a page at a time,
 * narrowed by a title search.
 */
export function useOwnStorylinePosts({
  enabled,
  excludePostId,
  publishedOnly = false,
  author,
}: {
  enabled: boolean;
  excludePostId?: number;
  /** Leaves out drafts and posts scheduled for later. */
  publishedOnly?: boolean;
  /** Whose posts to list, when not the viewer's: a moderator inserting for the owner. */
  author?: { id: number; username: string | null };
}) {
  const viewer = useCurrentUser();
  const currentUser = author ?? viewer;
  const [search, setSearch] = useState('');
  const [query] = useDebouncedValue(search.trim(), 300);
  // Every level: a post above the storyline's ceiling has to be listed to be refused out loud.
  // Newest, all time: the default sort lists only posts that already have reactions, which leaves
  // out the post just made to continue the story.
  const {
    data: postPages,
    isLoading: postsLoading,
    isError: postsError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = trpc.post.getInfinite.useInfiniteQuery(
    {
      username: currentUser?.username,
      browsingLevel: allBrowsingLevelsFlag,
      limit: STORYLINE_CONTINUE_POST_LIMIT,
      sort: PostSort.Newest,
      period: MetricTimeframe.AllTime,
      query: query || undefined,
    },
    { enabled: enabled && !!currentUser?.username, getNextPageParam: (page) => page.nextCursor }
  );
  const loaded = useMemo(() => postPages?.pages.flatMap((page) => page.items), [postPages]);
  const ownPosts = useMemo(
    () =>
      currentUser
        ? storylineContinuePostOptions(loaded ?? [], {
            viewerId: currentUser.id,
            parentPostId: excludePostId ?? 0,
          }).filter((post) => !publishedOnly || isPublished(post))
        : [],
    [currentUser, loaded, excludePostId, publishedOnly]
  );
  // Which of them are already chapters; the author is told whatever the post's level.
  const ownPostIds = useMemo(() => ownPosts.map((post) => post.id), [ownPosts]);
  const { data: ownChapters, isLoading: ownChaptersLoading } = trpc.storyline.getForPosts.useQuery(
    { postIds: ownPostIds, browsingLevel: allBrowsingLevelsFlag },
    // Keep the last answer while a refetch adds a post, so the grid does not blink to skeletons.
    { enabled: enabled && ownPostIds.length > 0, placeholderData: (previous) => previous }
  );
  const { posts, alreadyChapters } = storylineWithoutChapters(
    ownPosts,
    new Set(Object.keys(ownChapters ?? {}).map(Number))
  );
  return {
    posts,
    alreadyChapters,
    postsLoading: postsLoading || (ownPostIds.length > 0 && ownChaptersLoading),
    // A failed refetch keeps the posts already shown.
    postsError: postsError && !loaded,
    paging: {
      search,
      onSearchChange: setSearch,
      hasMore: !!hasNextPage,
      loadMore: () => void fetchNextPage(),
      loadingMore: isFetchingNextPage,
    } satisfies StorylinePostPaging,
  };
}
