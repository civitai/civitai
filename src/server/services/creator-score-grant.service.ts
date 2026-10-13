import type { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { dbWrite } from '~/server/db/client';
import { pgDbWrite } from '~/server/db/pgDb';
import {
  grantScoreTierCrossings,
  toScoreTotalTransitions,
  userScoreUpdateSql,
  type UserScoreUpdateRow,
} from '~/server/jobs/update-user-score';
import { CREATOR_SCORE_GRANT_LIMITS } from '~/server/services/creator-score-grant.constants';
import { getCreatorScoreUnlocks } from '~/server/services/creator-score-unlocks.service';
import type { ScoreTotalTransition } from '~/server/services/creator-milestone-grant.service';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
  throwRateLimitError,
} from '~/server/utils/errorHandling';
import { createLogger } from '~/utils/logging';

export { CREATOR_SCORE_GRANT_LIMITS } from '~/server/services/creator-score-grant.constants';

const log = createLogger('creator-score-grant');

/** Advisory-lock class ('CS'), registered in free-placement.service.test.ts's lock ledger. */
const GRANT_LOCK_CLASS = 0x43530001;

type RawClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe'>;

/**
 * Taken first in every grant and revoke transaction, before anything writes. Two grants for one
 * account each sum the ledger, and this makes the second wait for the first to commit so its sum
 * includes the first's row. It must come before the ledger insert: that insert's foreign key takes
 * KEY SHARE on this row, and two transactions holding that while each asked for the row would
 * deadlock. NO KEY UPDATE is the level the score UPDATE takes anyway, and it does not block
 * unrelated inserts that reference the user.
 */
export async function lockScoreRow(tx: RawClient, userId: number) {
  await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id = $1 FOR NO KEY UPDATE`, userId);
}

/**
 * Rewrites `User.meta.scores.staffAwarded` as the sum of the account's unrevoked grants and
 * recomputes `total` through the score job's own statement, so a grant and the nightly job can never
 * disagree on what the total is made of. Absolute rather than an increment: a revoke, a retry or a
 * hand-edited ledger row all converge on the ledger. The caller holds `lockScoreRow`.
 */
export async function syncStaffAwarded(
  tx: RawClient,
  userId: number
): Promise<ScoreTotalTransition> {
  const [row] = await tx.$queryRawUnsafe<{ staffAwarded: unknown }[]>(
    `SELECT COALESCE(SUM(amount), 0)::int AS "staffAwarded"
     FROM "CreatorScoreGrant" WHERE "userId" = $1 AND "revokedAt" IS NULL`,
    userId
  );
  // Number(): a driver can hand an integer back as a BigInt, which the score JSON cannot serialise.
  const staffAwarded = Number(row?.staffAwarded ?? 0);
  const rows = await tx.$queryRawUnsafe<UserScoreUpdateRow[]>(
    userScoreUpdateSql([[String(userId), { staffAwarded }]])
  );
  const [transition] = toScoreTotalTransitions(rows);
  if (!transition) throw throwNotFoundError(`No user with id ${userId}.`);
  return transition;
}

// The score is committed by the time this runs, so nothing here may fail the grant: a moderator who
// sees an error would grant again. A missed tier is picked up by the score-tier backfill.
async function grantTiersAfterCommit(transition: ScoreTotalTransition) {
  try {
    const tierGrantErrors: unknown[] = [];
    await grantScoreTierCrossings(
      { pg: pgDbWrite, tierUnlocks: await getCreatorScoreUnlocks(), tierGrantErrors },
      [transition]
    );
    if (tierGrantErrors.length) log('tier grant failed', transition.userId, tierGrantErrors[0]);
  } catch (e) {
    log('tier grant failed', transition.userId, e);
  }
}

/**
 * Award Creator Score to an account by hand. The grant row, its ModActivity row and the account's
 * new score are written in one transaction; tier milestones and their notifications follow exactly
 * as when the nightly job raises a total.
 */
export async function grantCreatorScore({
  userId,
  amount,
  reason,
  moderatorId,
}: {
  userId: number;
  amount: number;
  reason: string;
  moderatorId: number;
}) {
  const limits = CREATOR_SCORE_GRANT_LIMITS;
  if (!Number.isInteger(amount) || amount < 1 || amount > limits.maxAmount)
    throw throwBadRequestError(`Amount must be a whole number from 1 to ${limits.maxAmount}.`);
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw throwBadRequestError('A reason is required.');
  if (trimmedReason.length > limits.maxReasonLength)
    throw throwBadRequestError(`The reason is longer than ${limits.maxReasonLength} characters.`);
  if (userId === moderatorId)
    throw throwBadRequestError('You cannot grant Creator Score to your own account.');

  const target = await dbWrite.user.findFirst({
    where: { id: userId },
    select: { id: true, deletedAt: true },
  });
  if (!target || target.deletedAt) throw throwNotFoundError(`No live user with id ${userId}.`);

  const { grant, transition } = await dbWrite.$transaction(async (tx) => {
    // Serialises one moderator's grants so two concurrent requests cannot both pass the cap.
    // Both arguments int4: Prisma binds a JS number as int8, and there is no (int4, int8) overload.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${GRANT_LOCK_CLASS}::int, ${moderatorId}::int)`;
    await lockScoreRow(tx, userId);

    const granted = await tx.creatorScoreGrant.count({
      where: {
        grantedById: moderatorId,
        createdAt: { gt: dayjs().subtract(24, 'hour').toDate() },
      },
    });
    if (granted >= limits.dailyPerModerator)
      throw throwRateLimitError(
        `Daily limit of ${limits.dailyPerModerator} Creator Score grants per moderator reached.`
      );

    const grant = await tx.creatorScoreGrant.create({
      data: { userId, amount, reason: trimmedReason, grantedById: moderatorId },
      select: { id: true, amount: true, createdAt: true },
    });
    await trackModActivity(
      moderatorId,
      { entityType: 'user', entityId: userId, activity: `grantCreatorScore:${grant.id}:${amount}` },
      tx
    );
    return { grant, transition: await syncStaffAwarded(tx, userId) };
  });

  await grantTiersAfterCommit(transition);
  return { ...grant, total: transition.newTotal };
}

/**
 * Withdraw a grant. The row is stamped, not deleted, and the account's score is recomputed from what
 * is left. A tier milestone the grant already earned stays earned, as after any score drop.
 */
export async function revokeCreatorScoreGrant({
  grantId,
  userId,
  reason,
  moderatorId,
}: {
  grantId: number;
  userId: number;
  reason: string;
  moderatorId: number;
}) {
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw throwBadRequestError('A reason is required.');
  if (trimmedReason.length > CREATOR_SCORE_GRANT_LIMITS.maxReasonLength)
    throw throwBadRequestError(
      `The reason is longer than ${CREATOR_SCORE_GRANT_LIMITS.maxReasonLength} characters.`
    );

  return dbWrite.$transaction(async (tx) => {
    await lockScoreRow(tx, userId);
    const now = new Date();
    // Scoped to the account, so a grant cannot be revoked from another user's page; guarded on
    // still being active, so two revokes cannot both write an audit row.
    const { count } = await tx.creatorScoreGrant.updateMany({
      where: { id: grantId, userId, revokedAt: null },
      data: { revokedAt: now, revokedById: moderatorId, revokeReason: trimmedReason },
    });
    if (count !== 1) {
      const existing = await tx.creatorScoreGrant.findFirst({
        where: { id: grantId, userId },
        select: { revokedAt: true },
      });
      if (!existing)
        throw throwNotFoundError('No Creator Score grant with that id on this account.');
      throw throwConflictError('That grant has already been revoked.');
    }

    await trackModActivity(
      moderatorId,
      { entityType: 'user', entityId: userId, activity: `revokeCreatorScore:${grantId}` },
      tx
    );
    const transition = await syncStaffAwarded(tx, userId);
    return { id: grantId, revokedAt: now, total: transition.newTotal };
  });
}
