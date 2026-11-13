import type { Prisma } from '@prisma/client';

/**
 * Step (6) of `approveRequest`: the request's approved flip and the block's committed-sha
 * stamp, in one transaction with the final hold check. It runs after the code is committed, so a
 * hold the moderator was not shown cannot refuse it; it re-suspends the block instead (fail
 * closed), and the hold stays open for a moderator to clear before un-suspending.
 */
export async function finaliseOnsiteApprove(
  tx: Prisma.TransactionClient,
  input: {
    holdDecision: { slug: string; overrideReason?: string | null; shownHoldIds?: number[] | null };
    reviewerUserId: number;
    approvalNotes?: string | null;
    publishRequestId: string;
    appBlockId: string;
    forgejoCommitSha: string;
    screenshots: object;
  }
) {
  const { resolveHoldsAtApprove } = await import('./publish-request-holds.service');
  const { late } = await resolveHoldsAtApprove(tx, {
    ...input.holdDecision,
    actorUserId: input.reviewerUserId,
    afterSideEffects: true,
  });
  await tx.appBlockPublishRequest.update({
    where: { id: input.publishRequestId },
    data: {
      status: 'approved',
      reviewedByUserId: input.reviewerUserId,
      reviewedAt: new Date(),
      approvalNotes: input.approvalNotes,
      forgejoCommitSha: input.forgejoCommitSha,
      appBlockId: input.appBlockId,
    },
  });
  await tx.appBlock.update({
    where: { id: input.appBlockId },
    data: {
      currentVersionSha: input.forgejoCommitSha,
      // F-E E5 — persist the validated, uploaded screenshot records. Replaces
      // the prior set on a re-approve (the storeScreenshots keys are stable per
      // appBlockId+index, so the objects are overwritten in place). An empty
      // gallery is stored as [] so a re-submit that REMOVES all screenshots
      // clears the old set rather than leaving stale entries.
      screenshots: input.screenshots,
      ...(late.length ? { status: 'suspended' } : {}),
    },
  });
  return { lateHoldIds: late };
}
