import type { Prisma } from '@prisma/client';
import { revokeAppBlockOauthTokens } from './app-block-token-revoke.service';

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
  allowedScopes: bigint;
};

/** The on-site store listing as it was before this approve synced the new version's copy. */
export type PriorListing = {
  id: string;
  status: string;
  contentRating: string | null;
  name: string;
  tagline: string | null;
  description: string | null;
  category: string | null;
  /** Absent when the manual-apply column is not there yet. */
  sourceRepoUrl?: string | null;
  appBlockId: string | null;
  /** Unset when the column is not there yet, so there is nothing to put back. */
  issueTracker?: { value: string | null };
};

/**
 * Read on the primary before (3b) writes the listing. The two manual-apply columns are read only
 * when their probes say they exist: naming a missing column would fail the approve.
 */
export async function snapshotOnsiteListing(
  db: Prisma.TransactionClient,
  slug: string,
  columns: { sourceRepoAvailable: boolean; issueTrackerAvailable: boolean }
): Promise<PriorListing | undefined> {
  const row = await db.appListing.findUnique({
    where: { slug },
    select: {
      id: true,
      kind: true,
      status: true,
      contentRating: true,
      name: true,
      tagline: true,
      description: true,
      category: true,
      ...(columns.sourceRepoAvailable ? { sourceRepoUrl: true } : {}),
      appBlockId: true,
    },
  });
  if (!row || row.kind !== 'onsite') return undefined;
  const { kind: _kind, ...listing } = row;
  if (!columns.issueTrackerAvailable) return listing;
  const { readListingIssueTrackerUrl } = await import('./app-listing-issue-tracker.service');
  const tracker = await readListingIssueTrackerUrl(row.id, db);
  return tracker.available ? { ...listing, issueTracker: { value: tracker.value } } : listing;
}

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
    /** Unset for a first version: with no build behind it, it has nothing to serve. */
    priorVersion?: PriorRuntime;
    /** Unset when the app had no on-site listing before this approve. */
    priorListing?: PriorListing;
  }
) {
  const { resolveHoldsAtApprove } = await import('./publish-request-holds.service');
  const { late } = await resolveHoldsAtApprove(tx, {
    ...input.holdDecision,
    actorUserId: input.reviewerUserId,
    afterSideEffects: true,
  });
  // A held version stays pending: an 'approved' request is what the next version's review is
  // diffed against, and what every other reader takes as the live version.
  if (!late.length)
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
  if (!late.length) return { lateHoldIds: late, revokedTokens: null };
  const revoked = await revokeAppBlockOauthTokens(tx, input.appBlockId);
  // The held version's client ceiling and store copy go back to what they were before step (3).
  if (input.priorVersion) {
    await tx.oauthClient.update({
      where: { id: input.priorVersion.oauthClientId },
      data: { allowedScopes: input.priorVersion.allowedScopes },
    });
  }
  // Left as a mod reset leaves it (`resetRestoreWhere`), so the re-approve after the hold is
  // cleared publishes it and un-suspends the block.
  const prior = input.priorListing;
  if (!prior) {
    await tx.appListing.updateMany({
      where: { appBlockId: input.appBlockId, kind: 'onsite' },
      data: { status: 'pending' },
    });
    return { lateHoldIds: late, revokedTokens: revoked };
  }
  // Only a listing that was going live is left for that re-approve. Any other status (a delisted
  // app) goes back as it was, so the re-approve never republishes it.
  const { id, issueTracker, status, appBlockId, ...fields } = prior;
  const wasGoingLive = status === 'approved' || status === 'draft';
  await tx.appListing.update({
    where: { id },
    data: { ...fields, status: wasGoingLive ? 'pending' : status, appBlockId: input.appBlockId },
  });
  if (issueTracker) {
    const { writeListingIssueTrackerUrl } = await import('./app-listing-issue-tracker.service');
    await writeListingIssueTrackerUrl(tx, id, issueTracker.value);
  }
  return { lateHoldIds: late, revokedTokens: revoked };
}
