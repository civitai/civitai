import { Prisma } from '@prisma/client';
import {
  COM_FACE_INTENT_DISPUTE,
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
import { SYSTEM_NSFW_LOCK_META_KEY } from '@civitai/shared/rating-review';
import dayjs from '~/shared/utils/dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { preventReplicationLag } from '~/server/db/db-lag-helpers';
import { hasPendingMinorHashMatch } from '~/server/services/minor-hash.service';
import {
  COM_FACE_INTENT_LOCK_SOURCE,
  overturnComFaceIntentSql,
  dropReplacedRatingMarkerSql,
  restoreReplacedRatingMarkerSql,
  storedListingTextHash,
  suppressComFaceIntentRelockSql,
} from '~/server/services/model-com-face-intent.service';
import type { ModelMeta } from '~/server/schema/model.schema';
import { moderatorRuledNsfwSince } from '~/server/services/rating-review.entities';
import { hasLaterVerdictUnderLock, readSystemNsfwLockAt } from '~/server/utils/minor-flag-meta';
import { POI_HASH_MATCH_KEY } from '~/server/services/model.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { accountHoldSql, holdMarkerViewExists } from '~/server/services/legal-hold.service';
import { type ResolvedAppeal, settleResolvedAppeals } from '~/server/services/report.service';
import { TEXT_SCAN_FLAGS_KEY } from '~/server/services/text-scan/flag-snapshot';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { withoutSystemNsfwLockSql } from '~/server/utils/jsonb-object';
import { MATURE_LOCK_ATTRIBUTION_KEYS } from '~/shared/constants/mature-lock-reason.constants';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

type LockReviewDb = Pick<typeof dbRead, 'model' | 'appeal'>;

export type LockReviewState = {
  requestable: RequestableLock[];
  pending: boolean;
  /** Set while a recent request was closed with every setting it named still locked. */
  reopensAt: Date | null;
  /** The nsfw lock is the listing intent check's, added when the owner tried a civitai.com version. */
  comFaceIntent: boolean;
};

export const LOCK_REVIEW_UNAVAILABLE = "That setting can't be reviewed this way.";
/** Moderators only; never shown to the owner. */
export const LOCK_REVIEW_HELD =
  "The owner's account is under an evidence hold, so this review can't be approved now.";
/** Moderators only. */
export const LOCK_REVIEW_DETECTION_HELD =
  'A real person or minor detection on this model is waiting for a moderator. Rule on it first, or reject this review.';
/** The re-judging job only: the lock is no longer the intent lock it judged, so a moderator decides. */
export const LOCK_REVIEW_LOCK_CHANGED =
  "This nsfw lock is no longer the listing intent check's; a moderator must rule on it.";
/** The re-judging job only: a system rating verdict landed under the lock, so a moderator decides. */
export const LOCK_REVIEW_LATER_VERDICT =
  'A system rating verdict landed under this lock; a moderator must rule on it.';
/** Moderators only. */
export const LOCK_REVIEW_MATCH_CHECK_FAILED =
  "Couldn't check this model for a file match waiting for a moderator, so it can't be approved now. Try again.";

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
    select: { userId: true, lockedProperties: true, poi: true, minor: true, meta: true },
  });
  if (!model || model.userId !== userId) return null;

  const requestable = requestableLocks(model);
  // The intent check's lock only while no moderator has ruled on it since, a rejected review included:
  // a refiled dispute after a moderator upheld the lock goes to a moderator, never the job.
  const marker = (model.meta as ModelMeta | null)?.systemNsfwLock;
  const markedAt = readSystemNsfwLockAt(model.meta);
  const comFaceIntent =
    requestable.includes('nsfw') &&
    marker?.source === COM_FACE_INTENT_LOCK_SOURCE &&
    !!markedAt &&
    !(await moderatorRuledNsfwSince(modelId, markedAt, { alsoRejections: true }));
  if (!requestable.length) return { requestable, pending: false, reopensAt: null, comFaceIntent };

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
  if (!latest || !asked) return { requestable, pending: false, reopensAt: null, comFaceIntent };
  if (latest.status === AppealStatus.Pending)
    return { requestable, pending: true, reopensAt: null, comFaceIntent };

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
    comFaceIntent,
  };
}

const lockReviewKind = {
  context: { path: ['kind'], equals: LOCK_REVIEW_KIND },
} satisfies Prisma.AppealWhereInput;

/** The owner's in-app appeal on the model of one kind: a pending one, else the latest filed. Rows are
 *  reused, so a row's id says nothing about when it was last filed. */
export async function latestModelAppealOfKind({
  modelId,
  userId,
  lockReview,
}: {
  modelId: number;
  userId: number;
  lockReview: boolean;
}) {
  const [appeal] = await dbRead.$queryRaw<
    { id: number; status: AppealStatus; resolvedAt: Date | null }[]
  >`
    SELECT id, status, "resolvedAt" FROM "Appeal"
    WHERE "entityType" = 'Model' AND "entityId" = ${modelId} AND "userId" = ${userId}
      AND category IS NULL
      AND ${
        lockReview
          ? Prisma.sql`context->>'kind' = ${LOCK_REVIEW_KIND}`
          : Prisma.sql`COALESCE(context->>'kind', '') <> ${LOCK_REVIEW_KIND}`
      }
    ORDER BY status = 'Pending' DESC, "createdAt" DESC, id DESC
    LIMIT 1
  `;
  return appeal ?? null;
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
  // An nsfw lock the listing intent check added is re-judged by a job before a moderator sees it.
  // Only a request naming the nsfw lock alone: the job's approval lifts every lock a request names,
  // and the others are a moderator's.
  const dispute =
    state.comFaceIntent && locks.length === 1 && locks[0] === 'nsfw'
      ? COM_FACE_INTENT_DISPUTE
      : undefined;
  return lockReviewContext(locks as RequestableLock[], dispute);
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
  asDisputeJob,
}: {
  /** The request the moderator was shown; a model can carry another, after a transfer. */
  appealId: number;
  modelId: number;
  approve: boolean;
  userId: number;
  resolvedReason?: string;
  internalNotes?: string;
  /**
   * The re-judging job's approval, re-checked under the row lock: refused unless the nsfw lock is
   * still the intent lock the job judged (its marker stamped at `intentLockAt`), and refused when a
   * system rating verdict was recorded under it.
   */
  asDisputeJob?: { intentLockAt: string };
}) {
  const status = approve ? AppealStatus.Approved : AppealStatus.Rejected;
  if (resolvedReason) {
    const invalid = resolutionReasonError('lockReview', status, resolvedReason, internalNotes);
    if (invalid) throw throwBadRequestError(invalid);
  }

  const markerView = approve ? await holdMarkerViewExists() : false;
  // The listing an approval rules on, so it overturns only an intent detection of that text.
  const ruledTextHash = approve ? await storedListingTextHash(modelId) : null;
  // Outside the row lock: it reads the model's files and every moderator-flagged minor model's.
  let minorMatchPending = false;
  if (approve)
    minorMatchPending = await hasPendingMinorHashMatch(modelId, dbWrite).catch((error: Error) => {
      logToAxiom({
        type: 'error',
        name: 'lock-review-match-check',
        message: 'Minor file-match check failed; approval refused',
        appealId,
        modelId,
        error: error.message,
      });
      throw throwBadRequestError(LOCK_REVIEW_MATCH_CHECK_FAILED);
    });
  const { claimed, unlocked, dispute } = await dbWrite.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<
      {
        id: number;
        context: unknown;
        lockedProperties: string[] | null;
        poi: boolean;
        minor: boolean;
        held: boolean;
        ownerFiled: boolean;
        detectionHeld: boolean;
        lockSource: string | null;
        verdictMeta: unknown;
        intentPromptId: number | null;
      }[]
    >`
      SELECT a.id, a.context, m."lockedProperties", m.poi, m.minor,
        m.meta->'systemNsfwLock'->>'source' AS "lockSource",
        (m.meta->'comFaceIntent'->>'promptId')::int AS "intentPromptId",
        jsonb_build_object('systemNsfwLock', m.meta->'systemNsfwLock',
          'comFaceIntent', jsonb_build_object('laterVerdict', m.meta->'comFaceIntent'->'laterVerdict')
        ) AS "verdictMeta",
        a."userId" = m."userId" AS "ownerFiled",
        COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi' ? 'redetected'
          OR m.meta->${TEXT_SCAN_FLAGS_KEY}->'minor' ? 'redetected'
          OR m.meta ? ${POI_HASH_MATCH_KEY}, FALSE) AS "detectionHeld",
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
      if (row.poi || row.minor)
        throw throwBadRequestError(
          'This model is now flagged as a real person or a minor; its locks stay. Reject the review instead.'
        );
      if (row.detectionHeld || minorMatchPending)
        throw throwBadRequestError(LOCK_REVIEW_DETECTION_HELD);
      if (asDisputeJob) {
        // A moderator's ruling can replace the lock without a moderator activity row to show it.
        const marker = (row.verdictMeta as ModelMeta | null)?.systemNsfwLock;
        if (
          !locked.includes('nsfw') ||
          row.lockSource !== COM_FACE_INTENT_LOCK_SOURCE ||
          marker?.at !== asDisputeJob.intentLockAt
        )
          throw throwBadRequestError(LOCK_REVIEW_LOCK_CHANGED);
        if (hasLaterVerdictUnderLock(row.verdictMeta))
          throw throwBadRequestError(LOCK_REVIEW_LATER_VERDICT);
      }
      lift = locksToLift(asked.locks, locked);
      if (lift.length)
        await tx.model.update({
          where: { id: modelId },
          data: { lockedProperties: locked.filter((key) => !(lift as string[]).includes(key)) },
        });
      // As the model form does on a moderator's nsfw unlock: a later lock must not read as the system's.
      if (lift.includes('nsfw')) {
        await tx.$executeRaw`
          UPDATE "Model" SET meta = ${withoutSystemNsfwLockSql('meta')} WHERE id = ${modelId}
        `;
        // Lifting the intent check's own lock rules on the intent: its detection of this text is
        // overturned and the rating marker it replaced comes back. Any other lock is a ruling on
        // the rating only, as on the model form: the detection still gates the civitai.com face,
        // the stale marker goes, and only re-locking this text is suppressed.
        if (row.lockSource === COM_FACE_INTENT_LOCK_SOURCE) {
          await tx.$executeRaw(restoreReplacedRatingMarkerSql(modelId));
          await tx.$executeRaw(overturnComFaceIntentSql(modelId, ruledTextHash));
        } else {
          await tx.$executeRaw(dropReplacedRatingMarkerSql(modelId));
          if (ruledTextHash)
            await tx.$executeRaw(suppressComFaceIntentRelockSql(modelId, ruledTextHash));
        }
      }
    }

    // Appeal rows are reopened in place, which erases this ruling from the row: the owner's
    // explanation of a filter-set nsfw lock is dropped here instead, so it stays gone.
    if (asked.locks.includes('nsfw'))
      await tx.$executeRaw`
        UPDATE "Model"
        SET meta = jsonb_set(meta, ARRAY[${SYSTEM_NSFW_LOCK_META_KEY}::text],
          (meta -> ${SYSTEM_NSFW_LOCK_META_KEY}::text) - ${MATURE_LOCK_ATTRIBUTION_KEYS}::text[])
        WHERE id = ${modelId}
          AND jsonb_typeof(meta -> ${SYSTEM_NSFW_LOCK_META_KEY}::text) = 'object'
      `;

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

    return {
      claimed,
      unlocked: lift,
      dispute: asked.dispute === COM_FACE_INTENT_DISPUTE ? row : null,
    };
  });

  // The job logs its own approvals where it judges them; a second sample here would count them twice.
  if (dispute && !asDisputeJob) {
    const context = dispute.context as Record<string, unknown> | null;
    logToAxiom({
      type: 'info',
      name: 'model-com-face-intent-dispute',
      message: 'moderator-ruled',
      appealId,
      modelId,
      approved: approve,
      unlocked,
      autoReview: context?.autoReview ?? null,
      autoReviewAttempts: context?.autoReviewAttempts ?? null,
      firstPromptId: dispute.intentPromptId,
    }).catch(() => undefined);
  }

  if (unlocked.length) await preventReplicationLag('model', modelId);
  // The ruling is committed: a failed notice must not read as a failed ruling, which cannot be retried.
  await settleResolvedAppeals(claimed, { status, lockReview: { unlocked } }).catch((error: Error) =>
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
