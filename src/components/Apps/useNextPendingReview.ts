import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { reviewApprovalQueue } from '~/components/Apps/pendingApprovalQueue';
import { usePendingApprovalIds } from '~/components/Apps/reviewApprovalToasts';
import { nextPendingRequestId } from '~/components/Apps/reviewDecisionFlow';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * "After a decision, open the next submission" — shared by the review page and the full-page
 * preview, so both decide what "next" means the same way.
 *
 * Next = the OLDEST pending on-site request that is neither the one just decided nor waiting on
 * a delayed approval (`nextPendingRequestId`). One page of the queue is enough: the oldest is
 * always on the first page. When nothing is left, `caughtUp` turns true and the caller shows
 * "No more app submissions waiting"; when the queue has not loaded (or failed), it goes to the queue page rather
 * than guess that nothing is left.
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

  const openNext = useCallback(() => {
    if (!pendingQuery.data) {
      void router.push('/apps/review');
      return;
    }
    const exclude = new Set(pendingApprovalIds);
    exclude.add(publishRequestId);
    const next = nextPendingRequestId(pendingQuery.data.items, exclude);
    if (next) void router.push(`/apps/review/${next}`);
    else setCaughtUpFrom(publishRequestId);
  }, [pendingApprovalIds, publishRequestId, pendingQuery.data, router]);

  return { openNext, caughtUp };
}
