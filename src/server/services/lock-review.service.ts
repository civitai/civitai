import { Prisma } from '@prisma/client';
import {
  LOCK_REVIEW_COOLDOWN_DAYS,
  LOCK_REVIEW_KIND,
  type LockReviewContext,
  lockReviewContext,
  locksToLift,
  parseLockReviewContext,
  requestableLocks,
  type RequestableLock,
} from '@civitai/shared/lock-review';
import { resolutionReasonError } from '@civitai/shared/resolution-reasons';
import dayjs from '~/shared/utils/dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { preventReplicationLag } from '~/server/db/db-lag-helpers';
import { trackModActivity } from '~/server/services/moderator.service';
import { accountHoldSql, holdMarkerViewExists } from '~/server/services/legal-hold.service';
import { type ResolvedAppeal, settleResolvedAppeals } from '~/server/services/report.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

type LockReviewDb = Pick<typeof dbRead, 'model' | 'appeal'>;

export type LockReviewState = {
  requestable: RequestableLock[];
  pending: boolean;
  /** Set while a recent request was closed with every setting it named still locked. */
  reopensAt: Date | null;
};

export const LOCK_REVIEW_UNAVAILABLE = "That setting can't be reviewed this way.";
/** Moderators only; never shown to the owner. */
export const LOCK_REVIEW_HELD =
  "The owner's account is under an evidence hold, so this review can't be approved now.";

export async function getLockReviewState({
  modelId,
  userId,
  isModerator,
  db = dbRead,
}: {
  modelId: number;
  userId: number;
  isModerator?: boolean;
  db?: LockReviewDb;
}): Promise<LockReviewState | null> {
  if (isModerator) return null;
  const model = await db.model.findUnique({
    where: { id: modelId },
    select: { userId: true, lockedProperties: true, poi: true, minor: true },
  });
  if (!model || model.userId !== userId) return null;

  const requestable = requestableLocks(model);
  if (!requestable.length) return { requestable, pending: false, reopensAt: null };

  const latest = await db.appeal.findFirst({
    where: {
      entityType: EntityType.Model,
      entityId: modelId,
      userId,
      category: null,
      ...lockReviewKind,
    },
    orderBy: { id: 'desc' },
    select: { status: true, resolvedAt: true, context: true },
  });
  const asked = parseLockReviewContext(latest?.context);
  if (!latest || !asked) return { requestable, pending: false, reopensAt: null };
  if (latest.status === AppealStatus.Pending)
    return { requestable, pending: true, reopensAt: null };

  // A request whose settings were all left locked starts the cooldown; lifting any of them ends it.
  const locked = model.lockedProperties ?? [];
  const reopensAt =
    latest.resolvedAt && asked.locks.every((key) => locked.includes(key))
      ? dayjs(latest.resolvedAt).add(LOCK_REVIEW_COOLDOWN_DAYS, 'day').toDate()
      : null;
  return {
    requestable,
    pending: false,
    reopensAt: reopensAt && reopensAt > new Date() ? reopensAt : null,
  };
}

const lockReviewKind = {
  context: { path: ['kind'], equals: LOCK_REVIEW_KIND },
} satisfies Prisma.AppealWhereInput;
// A JSON path NOT alone also drops the NULL context every flag appeal has.
const flagAppealKind = {
  OR: [{ context: { equals: Prisma.AnyNull } }, { NOT: lockReviewKind }],
} satisfies Prisma.AppealWhereInput;

/** The owner's in-app appeal on the model of one kind: a pending one, else their latest. */
export function latestModelAppealOfKind({
  modelId,
  userId,
  lockReview,
}: {
  modelId: number;
  userId: number;
  lockReview: boolean;
}) {
  return dbRead.appeal.findFirst({
    where: {
      entityType: EntityType.Model,
      entityId: modelId,
      userId,
      category: null,
      ...(lockReview ? lockReviewKind : flagAppealKind),
    },
    // AppealStatus sorts Pending first. A takeover can leave the pending row older than a resolved one.
    orderBy: [{ status: 'asc' }, { id: 'desc' }],
    select: { id: true, status: true, resolvedAt: true },
  });
}

/** The owner's pending in-app appeal on the model, of either kind: there is at most one, but it need
 *  not be their newest row. */
export async function pendingModelAppeal({ modelId, userId }: { modelId: number; userId: number }) {
  const [appeal] = await dbWrite.$queryRaw<{ id: number; context: unknown }[]>`
    SELECT id, context FROM "Appeal"
    WHERE "entityType" = 'Model' AND "entityId" = ${modelId} AND "userId" = ${userId}
      AND category IS NULL AND status = 'Pending'
    LIMIT 1
  `;
  return appeal ? { id: appeal.id, lockReview: !!parseLockReviewContext(appeal.context) } : null;
}

/** Turns the owner's pending lock review into their flag appeal; refused if it changed meanwhile. */
export async function takeOverLockReview({ id, message }: { id: number; message: string }) {
  const { count } = await dbWrite.appeal.updateMany({
    where: { id, status: AppealStatus.Pending, category: null, ...lockReviewKind },
    data: { appealMessage: message, context: Prisma.DbNull, createdAt: new Date() },
  });
  if (!count) throw throwBadRequestError('Your review request changed meanwhile. Try again.');
  return { id, status: AppealStatus.Pending };
}

export async function assertLockReviewAllowed({
  modelId,
  userId,
  isModerator,
  locks,
  db,
}: {
  modelId: number;
  userId: number;
  isModerator?: boolean;
  locks: string[];
  db?: LockReviewDb;
}): Promise<LockReviewContext> {
  if (isModerator) throw throwBadRequestError('Moderators can change locked settings directly.');
  const state = await getLockReviewState({ modelId, userId, db });
  if (!state || !locks.length || !locks.every((key) => state.requestable.includes(key as never)))
    throw throwBadRequestError(LOCK_REVIEW_UNAVAILABLE);
  if (state.pending)
    throw throwBadRequestError('Your review request for this model is already under review');
  if (state.reopensAt)
    throw throwBadRequestError(
      `A moderator reviewed this recently. You can ask again on ${dayjs(state.reopensAt).format(
        'MMMM D, YYYY'
      )}.`
    );
  return lockReviewContext(locks as RequestableLock[]);
}

/**
 * Rules on a model's pending lock review. Approving unlocks only the settings the owner named that
 * are still locked, and never changes their values.
 */
export async function resolveLockReviewAppeal({
  appealId,
  modelId,
  approve,
  userId,
  resolvedReason,
  internalNotes,
}: {
  /** The request the moderator was shown; a model can carry another, after a transfer. */
  appealId: number;
  modelId: number;
  approve: boolean;
  userId: number;
  resolvedReason?: string;
  internalNotes?: string;
}) {
  const status = approve ? AppealStatus.Approved : AppealStatus.Rejected;
  if (resolvedReason) {
    const invalid = resolutionReasonError('lockReview', status, resolvedReason, internalNotes);
    if (invalid) throw throwBadRequestError(invalid);
  }

  const markerView = approve ? await holdMarkerViewExists() : false;
  const { claimed, unlocked } = await dbWrite.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<
      {
        id: number;
        context: unknown;
        lockedProperties: string[] | null;
        poi: boolean;
        minor: boolean;
        held: boolean;
        ownerFiled: boolean;
      }[]
    >`
      SELECT a.id, a.context, m."lockedProperties", m.poi, m.minor,
        a."userId" = m."userId" AS "ownerFiled",
        ${
          approve ? accountHoldSql(Prisma.raw('m."userId"'), markerView) : Prisma.sql`FALSE`
        } AS held
      FROM "Appeal" a
      JOIN "Model" m ON m.id = a."entityId"
      WHERE a.id = ${appealId} AND a."entityType" = 'Model' AND a."entityId" = ${modelId}
        AND a.status = 'Pending' AND a.category IS NULL
        AND a.context->>'kind' = ${LOCK_REVIEW_KIND}
      FOR UPDATE OF a, m
    `;
    const asked = parseLockReviewContext(row?.context);
    if (!row || !asked)
      throw throwBadRequestError('This model has no pending locked-setting review');

    let lift: RequestableLock[] = [];
    if (approve) {
      if (!row.ownerFiled)
        throw throwBadRequestError(
          'The model has changed owner since this was requested; reject the review instead.'
        );
      if (row.held) throw throwBadRequestError(LOCK_REVIEW_HELD);
      const locked = row.lockedProperties ?? [];
      if (row.poi || row.minor || locked.includes('poi') || locked.includes('minor'))
        throw throwBadRequestError(
          'This model is now flagged as a real person or a minor; its locks stay. Reject the review instead.'
        );
      lift = locksToLift(asked.locks, locked);
      if (lift.length)
        await tx.model.update({
          where: { id: modelId },
          data: { lockedProperties: locked.filter((key) => !(lift as string[]).includes(key)) },
        });
    }

    // Closed under the same lock, so a second moderator's ruling finds nothing pending.
    const claimed = await tx.$queryRaw<ResolvedAppeal[]>`
      UPDATE "Appeal"
      SET status = ${status}::"AppealStatus", "resolvedBy" = ${userId}, "resolvedAt" = now(),
        "resolvedReason" = ${resolvedReason ?? null}, "internalNotes" = ${internalNotes ?? null},
        "resolvedMessage" = NULL, "updatedAt" = now()
      WHERE id = ${row.id} AND status = 'Pending'
      RETURNING id, "entityId", "entityType", "resolvedAt", "buzzTransactionId", status, "userId",
        "createdAt"
    `;
    if (!claimed.length) throw throwBadRequestError('This review was ruled on meanwhile; reload.');

    // The same rows a moderator's own unlock on the model form writes.
    for (const activity of [
      approve ? ('approveLockReview' as const) : ('rejectLockReview' as const),
      ...lift.map((key) => `unlockProperty:${key}` as const),
    ])
      await trackModActivity(userId, { entityType: 'model', entityId: modelId, activity }, tx);

    return { claimed, unlocked: lift };
  });

  if (unlocked.length) await preventReplicationLag('model', modelId);
  // The ruling is committed: a failed notice must not read as a failed ruling, which cannot be retried.
  await settleResolvedAppeals(claimed, { status }).catch((error: Error) =>
    logToAxiom({
      type: 'error',
      name: 'lock-review-settle',
      message: 'Owner not told of a lock review ruling',
      appealId,
      modelId,
      error: error.message,
    })
  );
  return { unlocked };
}
