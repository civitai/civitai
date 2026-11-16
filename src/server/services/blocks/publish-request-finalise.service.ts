import type { Prisma } from '@prisma/client';

/**
 * Step (6) of `approveRequest`: the request's approved flip and the block's committed-sha
 * stamp, in one transaction with the final hold check. It runs after the code is committed, so a
 * hold the moderator was not shown cannot refuse it; it re-suspends the block instead (fail
 * closed), and the hold stays open for a moderator to clear before un-suspending.
 */
/** The fields the app runs under, as they were before this approve wrote the new version's. */
export type PriorRuntime = {
  block: {
    manifest: Prisma.InputJsonValue;
    version: string;
    approvedScopes: string[];
    contentRating: string;
    renderMode: string;
    trustTier: string;
  };
  oauthClientId: string;
  allowedScopes?: number;
};

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
    /** Unset for a first version: with no build behind it, it has nothing to serve. */
    priorVersion?: PriorRuntime;
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
    // A held version is never marked current, and its unreviewed manifest, scopes and tier are
    // put back to the ones the app ran under: a restore serves the current sha's build under
    // them, and a re-triggered build rebuilds only the current sha.
    data: late.length
      ? { status: 'suspended', ...input.priorVersion?.block }
      : {
          currentVersionSha: input.forgejoCommitSha,
          // Replaces the prior set; [] clears it when a re-submit removes every screenshot.
          screenshots: input.screenshots,
        },
  });
  if (late.length && input.priorVersion?.allowedScopes != null) {
    await tx.oauthClient.update({
      where: { id: input.priorVersion.oauthClientId },
      data: { allowedScopes: input.priorVersion.allowedScopes },
    });
  }
  return { lateHoldIds: late };
}
