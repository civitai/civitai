import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { reviewApprovalQueue } from '~/components/Apps/pendingApprovalQueue';
import { usePendingApprovalIds } from '~/components/Apps/reviewApprovalToasts';
import { nextPendingRequestId } from '~/components/Apps/reviewDecisionFlow';
import { reviewSkipList } from '~/components/Apps/reviewSkipList';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/** The server render (and hydration) has no session storage: nothing is skipped there. */
const NO_SKIPS: readonly string[] = [];
const noSkips = () => NO_SKIPS;

/**
 * "After a decision, open the next submission" — shared by the review page and the full-page
 * preview, so both decide what "next" means the same way.
 *
 * Next = the OLDEST pending on-site request that is not the one just decided, not waiting on a
 * delayed approval, and not SKIPPED this session (`reviewSkipList`) — `nextPendingRequestId`.
 * One page of the queue is enough: the oldest is always on the first page. When nothing is
 * left, `caughtUp` turns true and the caller shows "No more app submissions waiting"; when the
 * queue has not loaded (or failed), it goes to the queue page rather than guess that nothing is
 * left.
 *
 * `skip` opens the next one WITHOUT deciding this one: it only adds the id to the session's skip
 * list. When the only submissions left are skipped ones, `skippedPending` counts them and
 * `reviewSkipped` clears the list and opens the oldest; when none of them is pending any more,
 * the list is cleared on its own.
 */
export function useNextPendingReview(publishRequestId: string) {
  const features = useFeatureFlags();
  const router = useRouter();
  /*
    Keyed on the id it was reached FROM, not a bare boolean: "Approve & next" pushes this same
    dynamic route with a new id and Next keeps the page mounted, so a plain flag would carry
    "No more app submissions waiting" over to a submission opened afterwards.
  */
  const [caughtUpFrom, setCaughtUpFrom] = useState<string | null>(null);
  const caughtUp = caughtUpFrom === publishRequestId;
  const pendingQuery = trpc.blocks.listPendingRequests.useQuery(
    { limit: 50 },
    { enabled: !!features?.appBlocks && !!features?.appReviewPage, retry: false }
  );
  const pendingApprovalIds = usePendingApprovalIds();
  const skipped = useSyncExternalStore(reviewSkipList.subscribe, reviewSkipList.get, noSkips);

  /*
    🔴 An approval that does NOT go through UN-does "caught up". "Approve & next" on the LAST
    pending submission records A's approval and lands here with `caughtUpFrom = A` while the URL
    stays /apps/review/A; the toast's Undo then pushes that same URL, Next keeps the page
    mounted, and without this the moderator stayed on "No more app submissions waiting" with A
    un-approved. A failed commit re-opens A the same way. Either one means A is pending again,
    so the review shows A.
  */
  useEffect(
    () =>
      reviewApprovalQueue.subscribe((event) => {
        if (event.type !== 'undone' && event.type !== 'failed') return;
        setCaughtUpFrom((from) => (from === event.entry.id ? null : from));
      }),
    []
  );

  const items = pendingQuery.data?.items;
  /** Skipped submissions that are still pending and not awaiting an approval. */
  const skippedPending = useMemo(() => {
    if (!items) return 0;
    const set = new Set(skipped);
    return items.filter((r) => set.has(r.id) && !pendingApprovalIds.has(r.id)).length;
  }, [items, skipped, pendingApprovalIds]);

  const goNext = useCallback(
    (alsoSkip: string | null) => {
      if (!items) {
        void router.push('/apps/review');
        return;
      }
      const skippedNow = alsoSkip ? [...skipped, alsoSkip] : skipped;
      const exclude = new Set([...pendingApprovalIds, ...skippedNow, publishRequestId]);
      const next = nextPendingRequestId(items, exclude);
      if (next) {
        void router.push(`/apps/review/${next}`);
        return;
      }
      // The queue ran out. A skip list naming nothing that is still pending has done its job.
      const set = new Set(skippedNow);
      if (!items.some((r) => set.has(r.id) && !pendingApprovalIds.has(r.id))) {
        reviewSkipList.clear();
      }
      setCaughtUpFrom(publishRequestId);
    },
    [items, skipped, pendingApprovalIds, publishRequestId, router]
  );

  const openNext = useCallback(() => goNext(null), [goNext]);

  /** Open the next submission and leave this one pending. Sends nothing. */
  const skip = useCallback(() => {
    reviewSkipList.add(publishRequestId);
    goNext(publishRequestId);
  }, [goNext, publishRequestId]);

  /** Forget this session's skips and open the oldest pending submission again. */
  const reviewSkipped = useCallback(() => {
    reviewSkipList.clear();
    setCaughtUpFrom(null);
    if (!items) return;
    const next = nextPendingRequestId(items, pendingApprovalIds);
    if (next && next !== publishRequestId) void router.push(`/apps/review/${next}`);
  }, [items, pendingApprovalIds, publishRequestId, router]);

  return { openNext, skip, caughtUp, skippedPending, reviewSkipped };
}
