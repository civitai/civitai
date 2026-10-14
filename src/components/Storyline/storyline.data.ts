import type { StorylineSubmitOutcome } from '~/components/Storyline/continue/StorylineContinueForm';
import type { StorylineSpaceSettings } from '~/components/Storyline/manage/StorylineSettingsForm';
import type { StorylineQueueRow } from '~/components/Storyline/queue/StorylineQueueList';
import type {
  StorylineClosedReason,
  StorylineWhoCanContinue,
} from '~/components/Storyline/storyline-ui';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The storyline placement procedures answer `notAvailable` until the submission path is routed.
 * That is a state of the feature, not a failure, so the UI says "not available yet" for it rather
 * than an error.
 */
export const isStorylineNotAvailable = (error: { message: string } | null | undefined) =>
  error?.message === STORYLINE_REFUSALS.notAvailable;

const showError = (title: string) => (error: { message: string }) =>
  showErrorNotification({ title, error: new Error(error.message) });

/** The storyline's price, for its owner. */
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

  const space = query.data;
  return {
    data: space ? { setPrice: space.setPrice, price: space.price, cap: space.cap } : null,
    unavailable: isStorylineNotAvailable(query.error),
    isSaving: mutation.isPending,
    // The mode is carried as read: Complete closes the space server-side, and nothing here may
    // reopen it by writing a stale mode back.
    save: (price) => {
      if (space) mutation.mutate({ storylineId, mode: space.mode, price });
    },
  };
}

/**
 * Who may continue, from the storyline itself. The `whoCanContinue` column is not in the router
 * yet; until it is this reports `null` and the settings form disables the control.
 */
export function useStorylineWhoCanContinue(_storylineId: number): {
  value: StorylineWhoCanContinue | null;
  isSaving: boolean;
  save: (value: StorylineWhoCanContinue) => void;
} {
  return { value: null, isSaving: false, save: () => undefined };
}

/** What a contributor is told before submitting: the price, and whether they may continue. */
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
 * Submit returns the new placement only. Whether it went straight in (an endorsed collaborator)
 * is not reported, so the outcome says it was sent, or that it waits for the post's rating.
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
        onSuccess: () => {
          onSuccess(awaitingScan ? 'awaitingScan' : 'pending');
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

/** Continuations waiting on the viewer's storylines, one page at a time. */
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

/** Accept or decline one continuation. Rejects with the server's message on refusal. */
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
