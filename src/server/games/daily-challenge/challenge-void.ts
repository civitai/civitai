import { TRPCError } from '@trpc/server';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  closeChallengeCollection,
  getChallengeById,
} from '~/server/games/daily-challenge/challenge-helpers';
import { refundUserChallengeFunds } from '~/server/games/daily-challenge/challenge-funding';
import { logToAxiom } from '~/server/logging/client';
import { recordChallengeVoided } from '~/server/prom/challenge.metrics';
import { createNotification } from '~/server/services/notification.service';
import { voidPrizes } from '~/server/services/prize.service';
import { getEntryPoolContribution } from '~/shared/constants/challenge.constants';
import { ChallengeStatus, PrizeSourceType } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';

// Out of challenge.service so the NSFW escalation can void without importing it (import cycle:
// docs/dev/import-cycles.md).

const log = createLogger('challenge-service', 'blue');

/**
 * Distinct paying entrants for a challenge — owners of images *currently* entered into its
 * collection, excluding the creator. This is an approximation of "who actually got refunded",
 * not an exact match, and the divergence is accepted rather than re-architected to query the
 * buzz ledger: a moderator-added entry has a CollectionItem row despite its fee charge being
 * bypassed, so that user may be notified without having paid; and a paid entry removed from the
 * collection before the void still has its pool fee reversed by `refundUserChallengeFunds`
 * (matched by transaction-id prefix, independent of this query) but won't appear here, so that
 * payer won't be notified. The refund itself is unaffected either way — only this courtesy
 * notification is approximate.
 */
async function getPayingEntrantUserIds(collectionId: number, createdById: number | null) {
  const rows = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT DISTINCT i."userId"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."collectionId" = ${collectionId}
  `;
  return rows.map((r) => r.userId).filter((userId) => userId !== createdById);
}

/** Notify every distinct paying entrant that their challenge was cancelled/refunded. Call only
 * after a refund has actually happened (`refundedEntries > 0`) so no-fee/no-entrant/System
 * challenges never fire this. Best-effort: the refund has already succeeded by the time this
 * runs, so a failure here is logged and swallowed rather than propagating and blocking the
 * status flip to Cancelled/Completed. */
export async function notifyEntrantsOfCancellation(challenge: {
  id: number;
  title: string;
  collectionId: number | null;
  createdById: number | null;
  entryFee: number;
}) {
  if (!challenge.collectionId) return;
  try {
    const entrantUserIds = await getPayingEntrantUserIds(
      challenge.collectionId,
      challenge.createdById
    );
    if (entrantUserIds.length === 0) return;

    await createNotification({
      type: 'challenge-cancelled',
      category: NotificationCategory.System,
      key: `challenge-cancelled:${challenge.id}`,
      userIds: entrantUserIds,
      details: {
        challengeId: challenge.id,
        challengeTitle: challenge.title,
        refundedBuzz: getEntryPoolContribution(challenge.entryFee),
      },
    });
    log(`Notified ${entrantUserIds.length} entrants of challenge cancellation`);
  } catch (err) {
    logToAxiom({
      type: 'error',
      name: 'challenge-cancelled-notification',
      challengeId: challenge.id,
      message: (err as Error).message,
    });
  }
}

/**
 * Void a challenge without picking winners: claim it to Cancelled, void prizes, close the
 * collection, refund entry fees. Returns `voided: false` when a completion or concurrent void won
 * the claim.
 */
export async function voidChallenge(
  challengeId: number,
  // Telemetry-only: why the void was triggered. Normalized to a closed set in the metric helper
  // (moderator|nsfw|activation|other); does not affect behavior.
  reason: 'moderator' | 'nsfw' | 'activation' | 'other' = 'other'
) {
  const challenge = await getChallengeById(challengeId);
  if (!challenge) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Challenge not found' });
  }

  // Cancelled is allowed so a void whose refund threw mid-way can be re-run to finish the
  // (idempotent) refund, rather than stranding the funds.
  if (
    challenge.status !== ChallengeStatus.Active &&
    challenge.status !== ChallengeStatus.Scheduled &&
    challenge.status !== ChallengeStatus.Cancelled
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Cannot void challenge with status "${String(
        challenge.status
      )}". Challenge must be Active, Scheduled, or Cancelled.`,
    });
  }

  log('Voiding challenge:', challengeId);

  // Claim the row (Active/Scheduled -> Cancelled) BEFORE refunding, unless it is already Cancelled
  // (a retry of a prior void whose refund failed — skip the claim and just re-refund idempotently).
  // The claim stops (a) two concurrent voids from both refunding, and (b) — critically — a void from
  // refunding a pool the completion cron is simultaneously claiming to pay to winners, which would
  // mint (the cron's own Active->Completing claim can no longer win once we've flipped to Cancelled).
  // If the claim is lost, another void or completion advanced the row; do not refund here — a
  // stranded refund is recovered by re-running void, which lands on the Cancelled branch below.
  if (challenge.status !== ChallengeStatus.Cancelled) {
    const claimed = await dbWrite.challenge.updateMany({
      where: {
        id: challengeId,
        status: { in: [ChallengeStatus.Active, ChallengeStatus.Scheduled] },
      },
      data: { status: ChallengeStatus.Cancelled },
    });
    if (claimed.count !== 1) {
      log('Void claim lost (completion or a concurrent void won); skipping refund');
      // `voided: false` so callers can tell "nothing was refunded" from a real void — reporting a
      // refund that never happened would tell entrants they got their Buzz back.
      return { success: true, voided: false };
    }
    log('Challenge status updated to Cancelled');
  }

  // A completion that awarded prizes and then failed is reset to Active, so it can still be voided
  // here; the pool is refunded below, so what it awarded must not also be claimable.
  await voidPrizes(PrizeSourceType.Challenge, challengeId);

  await closeChallengeCollection(challenge);
  log('Collection closed');

  const { refundedEntries } = await refundUserChallengeFunds(challengeId, 'void');
  log(`Refunded ${refundedEntries} entry fees`);
  if (refundedEntries > 0) {
    await notifyEntrantsOfCancellation(challenge);
  }

  recordChallengeVoided({ source: challenge.source, reason });
  return { success: true, voided: true };
}
