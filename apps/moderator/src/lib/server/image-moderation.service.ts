import { sql } from '@civitai/db/kysely';
import { isFeedbackCaptureOwner } from '@civitai/shared/feedback-capture';
import { dbRead, dbWrite } from './db';
import { dropBlockedImageDeleteQueue } from './blocked-image-queue';
import { insertModActivityBatch, recordModActivity } from './mod-activity';
import { syncSearchIndex } from './search-index';
import { upsertTagsOnImageNew } from './tags-on-image.service';
import {
  applyBlockSideEffects,
  applyAcceptSideEffects,
  applyVisibilitySideEffects,
  refundAppealFee,
  notifyAppealResolved,
  emailAppealResolution,
  trackImageRestore,
} from './image-moderation-effects';
import { invalidateThumbnails, thumbnailParentId } from './thumbnail-cache';
import { bustProfilePictures } from './profile-picture-cache';
import { NsfwLevel } from '@civitai/shared';
import { FLAG_KEPT_THROUGH_BLOCK } from '$lib/image-review';
import { holdRemovals, type HeldRemoval } from './removal-hold';
import {
  claimDeferredBlockEffects,
  dropDeferredBlockEffects,
  fireDeferredBlockEffects,
  type DeferredBlockEffect,
} from './deferred-block-effects';
import {
  imagesVersion,
  imageVersion,
  removedNotDismissed,
  setAsideCounts,
  setAsideState,
} from './csam-queue-set-aside';
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// The negation of `isFlagOnlyRemaining`, written null-safe: `NOT (needsReview = x AND ...)` is NULL,
// not true, for every row with no flag, and would refuse every ordinary accept.
const NOT_FLAG_ONLY_REMAINING = sql<boolean>`("needsReview" IS DISTINCT FROM ${FLAG_KEPT_THROUGH_BLOCK} OR "ingestion" <> 'Blocked')`;

const BLOCKED_REASON_MODERATED = 'moderated';
const BLOCKED_REASON_CSAM = 'CSAM';

/**
 * Removed for CSAM, or under the review flag and not dismissed from its queue. A block of a held image
 * sends no owner notice and actions no report: for one under review they wait in
 * `ImageDeferredBlockEffect` for the review to close. The main app's twin is `heldImageSql`.
 */
const HELD_IMAGE = sql<boolean>`("blockedFor" = ${BLOCKED_REASON_CSAM} OR ("needsReview" = ${FLAG_KEPT_THROUGH_BLOCK} AND NOT EXISTS (
  SELECT 1 FROM "CsamQueueSetAside" s WHERE s."imageId" = "Image".id AND s.outcome = 'Dismissed'
)))`;

/**
 * The two `Image.metadata` breadcrumbs the main app's account-deletion grace block writes, spelled
 * out here for the same reason `BLOCKED_REASON_MODERATED` is: this app does not import from the
 * main app's `src/`. Canonical definitions are `PRIOR_INGESTION_KEY` / `PRIOR_BLOCKED_FOR_KEY` in
 * `src/server/utils/image-removal-mode.ts`, and the drift between the two spellings is pinned by
 * `src/server/services/__tests__/account-deletion-marker-clearing.test.ts`.
 *
 * A block strips them: the main app's restore path un-blocks an image on the presence of the first
 * key alone, so a row marked during a grace period and then moderated would be put back by a later
 * account restore.
 */
const ACCOUNT_DELETION_PRIOR_INGESTION_KEY = 'accountDeletionPriorIngestion';
const ACCOUNT_DELETION_PRIOR_BLOCKED_FOR_KEY = 'accountDeletionPriorBlockedFor';

const recompute = async (imageId: number) => {
  await sql`SELECT update_nsfw_levels_new(ARRAY[${imageId}::int])`.execute(dbWrite);
  await invalidateThumbnails(imageId);
  await bustProfilePictures({ imageIds: [imageId] });
};

// update_nsfw_levels_new skips nsfwLevelLocked rows, so a locked Blocked image would stay hidden after
// unblock. Zeroes the level and drops the lock; the caller must run recompute afterwards.
const resetBlockedNsfwLevel = (imageId: number) =>
  dbWrite
    .updateTable('Image')
    .set({ nsfwLevel: 0, nsfwLevelLocked: false })
    .where('id', '=', imageId)
    .where('nsfwLevel', '=', NsfwLevel.Blocked)
    .execute();

/** An accept refused because the image is removed and a review queue cannot put it back. */
export class RemovedImageNotRestorableError extends Error {
  constructor(readonly imageId: number) {
    super(`Image ${imageId} is removed, and a review queue cannot put it back`);
  }
}

export async function acceptImage({
  imageId,
  removeMinorFlag = false,
  userId,
  deferAppealEmail = false,
  restoreRemoved = false,
}: {
  imageId: number;
  removeMinorFlag?: boolean;
  userId: number;
  deferAppealEmail?: boolean;
  /** An explicit unblock. Review queues leave it off, so an image removed with only the review flag
   *  left cannot come back live from one; they throw `RemovedImageNotRestorableError` instead. */
  restoreRemoved?: boolean;
}): Promise<ClosedAppeal | undefined> {
  const img = await dbRead
    .selectFrom('Image')
    .select(['needsReview', 'pHash', 'postId', 'ingestion', 'blockedFor'])
    .where('id', '=', imageId)
    .executeTakeFirst();
  if (!img) return;
  const nr = img.needsReview;

  // remixSource: stamp remixSourceReviewed so the audit job doesn't re-flag it. COALESCE guards the usual
  // metadata=NULL — both `-` and `||` NULL-propagate, silently dropping the stamp otherwise.
  const metadataExpr =
    nr === 'remixSource'
      ? sql`(COALESCE("metadata", '{}'::jsonb) - 'ruleId' - 'ruleReason') || '{"remixSourceReviewed": true}'::jsonb`
      : sql`"metadata" - 'ruleId' - 'ruleReason'`;

  // Refused in the statement itself, not off the replica read above.
  const { numUpdatedRows } = await dbWrite
    .updateTable('Image')
    .set({
      needsReview: null,
      blockedFor: null,
      ingestion: 'Scanned',
      metadata: metadataExpr,
      ...(nr === 'poi' ? { poi: false } : {}),
      ...(nr === 'minor'
        ? {
            minor: removeMinorFlag
              ? false
              : sql<boolean>`CASE WHEN "nsfwLevel" >= 4 THEN FALSE ELSE TRUE END`,
          }
        : {}),
      ...(nr && ['minor', 'poi', 'newUser', 'bestiality'].includes(nr)
        ? { scannedAt: sql`now()` }
        : {}),
    })
    .where('id', '=', imageId)
    .$if(!restoreRemoved, (qb) =>
      qb.where(NOT_FLAG_ONLY_REMAINING).where('blockedFor', 'is distinct from', BLOCKED_REASON_CSAM)
    )
    .executeTakeFirst();
  if (!numUpdatedRows) {
    if (restoreRemoved) return;
    throw new RemovedImageNotRestorableError(imageId);
  }
  await dropBlockedImageDeleteQueue(imageId);
  await resetBlockedNsfwLevel(imageId);

  const reviewTags = await dbRead
    .selectFrom('ImageTagForReview')
    .select('tagId')
    .where('imageId', '=', imageId)
    .execute();
  if (reviewTags.length) {
    await upsertTagsOnImageNew(
      reviewTags.map((t) => ({
        imageId,
        tagId: t.tagId,
        automated: false,
        disabled: true,
        needsReview: false,
      }))
    );
    await dbWrite.deleteFrom('ImageTagForReview').where('imageId', '=', imageId).execute();
  } else {
    await recompute(imageId);
    syncSearchIndex({ entityType: 'image', entityId: imageId, action: 'update' });
  }

  // Only a moderator removal is logged as one, so only its undoing is a restore. A scanner block
  // (`AiNotVerified` in the POI queue) has no removal event to pair with.
  if (img.ingestion === 'Blocked' && img.blockedFor === BLOCKED_REASON_MODERATED)
    await trackImageRestore({ imageId, actorUserId: userId });

  await recordModActivity({ userId, entityType: 'image', entityId: imageId, activity: 'review' });

  await applyAcceptSideEffects(img, imageId);

  // Drops its blocks' deferred effects unfired. Last and best-effort: the image is already restored.
  await dropDeferredBlockEffects(dbWrite, [imageId]).catch((e: Error) =>
    console.error('[accept] deferred block effects not dropped', { imageId, error: e.message })
  );

  if (nr === 'appeal') {
    const appeal = await closePendingAppeal(imageId, {
      status: 'Approved',
      resolvedBy: userId,
      resolvedAt: new Date(),
    });
    if (appeal) await runAppealCascade(appeal, imageId, true, undefined, !deferAppealEmail);
    return appeal;
  }
}

/**
 * True when the image already carries this app's moderation block. A block from anywhere else (an
 * account-deletion grace block, an automated reason) is weaker and reversible, so it does not count.
 */
export async function isModerationBlocked(imageId: number): Promise<boolean> {
  const row = await dbWrite
    .selectFrom('Image')
    .select('id')
    .where('id', '=', imageId)
    .where('ingestion', '=', 'Blocked')
    .where('blockedFor', '=', BLOCKED_REASON_MODERATED)
    .where(sql<boolean>`("metadata" -> ${ACCOUNT_DELETION_PRIOR_INGESTION_KEY}::text) IS NULL`)
    .executeTakeFirst();
  return !!row;
}

/** `HELD_IMAGE`, read on the primary. */
export async function isHeldImage(imageId: number): Promise<boolean> {
  const row = await dbWrite
    .selectFrom('Image')
    .select(HELD_IMAGE.as('held'))
    .where('id', '=', imageId)
    .executeTakeFirst();
  return !!row?.held;
}

export async function blockImage({
  imageId,
  userId,
  ip,
  userAgent,
  violationType,
  violationDetails,
  reportIds,
  source = 'moderator.block',
  skipAppealCheck = false,
}: {
  imageId: number;
  userId: number;
  ip?: string;
  userAgent?: string;
  violationType?: string;
  violationDetails?: string;
  /** Reports the caller actions after the block; kept on a held removal so confirming actions them. */
  reportIds?: number[];
  /** The removal path, recorded on a held removal. */
  source?: string;
  /** The actor may confirm re-removals themselves, or this IS the confirmation. */
  skipAppealCheck?: boolean;
}): Promise<{
  held?: HeldRemoval;
  /** `HELD_IMAGE`: the caller leaves its reports open. */
  skipped?: true;
}> {
  const img = await dbRead
    .selectFrom('Image')
    .select([
      'needsReview',
      'pHash',
      'blockedFor',
      'postId',
      'nsfwLevel',
      'userId',
      thumbnailParentId.as('parentId'),
    ])
    .where('id', '=', imageId)
    .executeTakeFirst();
  if (!img) return {};

  if (!skipAppealCheck) {
    const { held } = await holdRemovals(
      [{ imageId, violationType, violationDetails, reportIds }],
      userId,
      source
    );
    if (held.length) return { held: held[0] };
  }

  const { updated, state } = await dbWrite.transaction().execute(async (tx) => {
    const updated = await tx
      .updateTable('Image')
      .set({
        // The moderator-only review flag survives a block: only its own queue, a filed report or an
        // explicit unblock clears it.
        needsReview: sql<
          string | null
        >`CASE WHEN "needsReview" = ${FLAG_KEPT_THROUGH_BLOCK} THEN "needsReview" END`,
        ingestion: 'Blocked',
        nsfwLevel: NsfwLevel.Blocked,
        blockedFor: sql<string>`CASE WHEN "blockedFor" = ${BLOCKED_REASON_CSAM} THEN "blockedFor" ELSE ${BLOCKED_REASON_MODERATED} END`,
        updatedAt: new Date(),
        // Two things happen to `metadata` on a block, and they compose in one expression:
        //   - the account-deletion breadcrumbs come off, always. `jsonb - key` NULL-propagates, so a
        //     row whose metadata is NULL stays NULL rather than becoming `{}`.
        //   - remixSource gets its stamp. COALESCE guards the usual metadata=NULL, because `||`
        //     NULL-propagates too and would drop the stamp.
        metadata:
          img.needsReview === 'remixSource'
            ? sql`(COALESCE("metadata", '{}'::jsonb) - ${ACCOUNT_DELETION_PRIOR_INGESTION_KEY}::text - ${ACCOUNT_DELETION_PRIOR_BLOCKED_FOR_KEY}::text) || '{"remixSourceReviewed": true}'::jsonb`
            : sql`"metadata" - ${ACCOUNT_DELETION_PRIOR_INGESTION_KEY}::text - ${ACCOUNT_DELETION_PRIOR_BLOCKED_FOR_KEY}::text`,
      })
      .where('id', '=', imageId)
      // Already removed with only the review flag left: blocking again would only notify the uploader a
      // second time. Decided here, not off the replica read above.
      .where(NOT_FLAG_ONLY_REMAINING)
      .returning('id')
      .executeTakeFirst();
    // A statement of its own, after the UPDATE took the row lock: one that waited on a dismissal
    // reads the set-aside row that dismissal committed.
    const state = await tx
      .selectFrom('Image')
      .select([
        HELD_IMAGE.as('held'),
        sql<boolean>`"blockedFor" = ${BLOCKED_REASON_CSAM}`.as('removedForCsam'),
        sql<boolean>`"needsReview" = ${FLAG_KEPT_THROUGH_BLOCK}`.as('underReview'),
      ])
      .where('id', '=', imageId)
      .executeTakeFirst();
    // A re-block of an image already removed under the flag defers its reports, not a notice.
    if (state?.held && !state.removedForCsam)
      await tx
        .insertInto('ImageDeferredBlockEffect')
        .values({
          imageId,
          violationType: violationType ?? null,
          notifyOwner: !!updated,
          reportIds: reportIds ?? [],
          blockedBy: userId,
        })
        .onConflict((oc) =>
          oc.column('imageId').doUpdateSet({
            notifyOwner: sql<boolean>`"ImageDeferredBlockEffect"."notifyOwner" OR excluded."notifyOwner"`,
            reportIds: sql<
              number[]
            >`ARRAY(SELECT DISTINCT unnest("ImageDeferredBlockEffect"."reportIds" || excluded."reportIds"))`,
          })
        )
        .execute();
    return { updated: !!updated, state };
  });
  if (!updated) return state?.held ? { skipped: true } : {};
  const blocked = state!;
  await keepPendingAppealFlag(imageId);
  await invalidateThumbnails(imageId, [img.parentId]);
  await bustProfilePictures({ imageIds: [imageId] });

  await recordModActivity({ userId, entityType: 'image', entityId: imageId, activity: 'review' });
  syncSearchIndex({ entityType: 'image', entityId: imageId, action: 'delete' });

  // `img` is the pre-block row (read above, before the update).
  await applyBlockSideEffects(img, {
    imageId,
    actorUserId: userId,
    ip,
    userAgent,
    violationType,
    violationDetails,
    heldImage: blocked.held,
    underReview: blocked.underReview,
  });
  return blocked.held ? { skipped: true } : {};
}

export type DismissResult = { ok: true } | { ok: false; reason: 'changed' | 'unavailable' };

/**
 * Takes a removed image out of the CSAM review queue as dismissed, leaving the image itself as it is:
 * flag and block untouched. What its block put off then runs (`fireDeferredBlockEffects`). `version` is the `imageVersion` the moderator was shown; an
 * image written since (reported again, say) is 'changed', as is one no longer removed and flagged or
 * already dismissed.
 */
export async function dismissFromCsamQueue({
  imageId,
  version,
  userId,
}: {
  imageId: number;
  version: string;
  userId: number;
}): Promise<DismissResult> {
  let claimed: DeferredBlockEffect[] = [];
  const result = await dbWrite.transaction().execute(async (tx) => {
    const state = await setAsideState(tx);
    if (!state.writable) return { ok: false, reason: 'unavailable' } as const;
    const image = await tx
      .selectFrom('Image as i')
      .select('i.userId')
      .where('i.id', '=', imageId)
      .where('i.needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
      .where('i.ingestion', '=', 'Blocked')
      .where(imageVersion('i'), '=', version)
      .forUpdate()
      .executeTakeFirst();
    if (!image) return { ok: false, reason: 'changed' } as const;
    const dismissed = await insertDismissals(tx, [{ imageId, userId: image.userId }], userId);
    claimed = dismissed.claimed;
    return dismissed.count === 1
      ? ({ ok: true } as const)
      : ({ ok: false, reason: 'changed' } as const);
  });
  if (result.ok) await fireDeferredBlockEffects(claimed, { moderatorId: userId });
  return result;
}

export type DismissUserResult =
  | { ok: true; dismissed: number; remaining: number }
  | { ok: false; reason: 'changed' | 'unavailable' | 'capture' };

class QueueChanged extends Error {}

/**
 * `dismissFromCsamQueue` for every one of one user's removed, flagged images not already dismissed,
 * in one transaction. `expectedCount` and `version` (`imagesVersion` of those images) are what the
 * moderator was shown; anything else rolls back, so nothing is dismissed that was not shown as it is
 * now. `remaining` is what still needs a verdict.
 */
export async function dismissUserFromCsamQueue({
  userId,
  expectedCount,
  version,
  moderatorId,
}: {
  userId: number;
  expectedCount: number;
  version: string;
  moderatorId: number;
}): Promise<DismissUserResult> {
  // Captures belong to no one; each is dismissed on its own, from its image.
  if (isFeedbackCaptureOwner(userId)) return { ok: false, reason: 'capture' };
  let claimed: DeferredBlockEffect[] = [];
  try {
    const result = await dbWrite.transaction().execute(async (tx) => {
      const state = await setAsideState(tx);
      if (!state.writable) return { ok: false, reason: 'unavailable' } as const;
      const live = removedNotDismissed(tx, state).where('i.userId', '=', userId);
      const images = await live.select('i.id').orderBy('i.id').forUpdate().execute();
      if (images.length !== expectedCount) throw new QueueChanged();
      // Under the row locks just taken, so no write lands between this and the inserts.
      const shown = await live.select(imagesVersion('i').as('version')).executeTakeFirst();
      if (shown?.version !== version) throw new QueueChanged();
      const rows = images.map(({ id }) => ({ imageId: id, userId }));
      const dismissed = await insertDismissals(tx, rows, moderatorId);
      if (dismissed.count !== rows.length) throw new QueueChanged();
      claimed = dismissed.claimed;
      const { remaining } = await tx
        .selectFrom('Image as i')
        .select(sql<number>`count(*)::int`.as('remaining'))
        .where('i.userId', '=', userId)
        .where('i.needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
        .where(sql<boolean>`not ${setAsideCounts('i', state)}`)
        .executeTakeFirstOrThrow();
      return { ok: true, dismissed: rows.length, remaining: Number(remaining) } as const;
    });
    await fireDeferredBlockEffects(claimed, { moderatorId });
    return result;
  } catch (e) {
    if (e instanceof QueueChanged) return { ok: false, reason: 'changed' };
    throw e;
  }
}

/** Writes a Dismissed row and its log entry for each image without a row, and claims those images'
 *  deferred block effects. Returns how many rows it wrote. */
async function insertDismissals(
  tx: Transaction<DB>,
  rows: { imageId: number; userId: number }[],
  moderatorId: number
): Promise<{ count: number; claimed: DeferredBlockEffect[] }> {
  if (!rows.length) return { count: 0, claimed: [] };
  const inserted = await tx
    .insertInto('CsamQueueSetAside')
    .values(
      rows.map((r) => ({
        ...r,
        outcome: 'Dismissed' as const,
        moderatorId,
        createdAt: sql<Date>`now() AT TIME ZONE 'UTC'`,
      }))
    )
    .onConflict((oc) => oc.column('imageId').doNothing())
    .returning('imageId')
    .execute();
  // Never one of the main app's MODERATOR_TAKEDOWN_ACTIVITIES, which license destroying the image.
  await insertModActivityBatch(tx, {
    userId: moderatorId,
    entityType: 'image',
    entityIds: inserted.map((r) => r.imageId),
    activity: 'dismissFromCsamQueue',
  });
  const claimed = await claimDeferredBlockEffects(
    tx,
    inserted.map((r) => r.imageId)
  );
  return { count: inserted.length, claimed };
}

/**
 * The appeals queue reads `needsReview = 'appeal'` and the blocked-image purge spares only flagged
 * rows, so a block must leave the flag on while the appeal is Pending. A separate statement, not a
 * CASE in the block's own SET: that one re-checks under the row lock with its start-of-statement
 * snapshot, so it misses an appeal committed while it waited.
 */
async function keepPendingAppealFlag(imageId: number) {
  await keepPendingAppealFlags(dbWrite, [imageId]);
}

/** `keepPendingAppealFlag` for a close that takes the review flag off. */
export async function keepPendingAppealFlags(db: Kysely<DB>, imageIds: readonly number[]) {
  if (!imageIds.length) return;
  await db
    .updateTable('Image')
    .set({ needsReview: 'appeal' })
    .where('id', 'in', [...imageIds])
    .where('needsReview', 'is distinct from', FLAG_KEPT_THROUGH_BLOCK)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('Appeal')
          .select('Appeal.id')
          .where('Appeal.entityType', '=', 'Image')
          .whereRef('Appeal.entityId', '=', 'Image.id')
          .where('Appeal.status', '=', 'Pending')
      )
    )
    .execute();
}

export type AppealDecision = 'Approved' | 'Rejected';

export const APPEAL_RESTORE_REFUSED =
  'This image is removed, and approving its appeal cannot put it back. The appeal is still pending: reject it, or restore the image explicitly.';

/** An approval refused because the image is `HELD_IMAGE`: the appeal stays Pending. */
export class AppealRestoreRefusedError extends Error {
  constructor(readonly imageId: number) {
    super(`Image ${imageId} is removed, and approving its appeal cannot put it back`);
  }
}

/**
 * Closes the image's pending appeal and returns it, or nothing when another resolution closed it
 * first. Closing and reading must stay one statement, or concurrent resolutions both refund the fee.
 */
function closePendingAppeal(
  imageId: number,
  decision: {
    status: AppealDecision;
    resolvedBy: number;
    resolvedAt: Date;
    resolvedMessage?: string | null;
    resolvedReason?: string;
    internalNotes?: string;
  }
) {
  return (
    dbWrite
      .updateTable('Appeal')
      .set(decision)
      .where('entityType', '=', 'Image')
      .where('entityId', '=', imageId)
      .where('status', '=', 'Pending')
      // Removed-content appeals are decided on /images/removed-appeals, not here.
      .where('entityRemovedAt', 'is', null)
      // An approval never closes over a `HELD_IMAGE`; the restore below re-checks it.
      .$if(decision.status === 'Approved', (qb) =>
        qb.where(
          sql<boolean>`NOT EXISTS (SELECT 1 FROM "Image" WHERE "id" = ${imageId} AND ${HELD_IMAGE})`
        )
      )
      .returning(['id', 'userId', 'buzzTransactionId'])
      .executeTakeFirst()
  );
}

export type ClosedAppeal = NonNullable<Awaited<ReturnType<typeof closePendingAppeal>>>;

async function runAppealCascade(
  appeal: ClosedAppeal,
  imageId: number,
  approved: boolean,
  resolvedMessage?: string,
  sendEmail = true
): Promise<void> {
  if (approved)
    await refundAppealFee({
      id: appeal.id,
      buzzTransactionId: appeal.buzzTransactionId,
      entityType: 'Image',
      entityId: imageId,
    });
  await notifyAppealResolved({
    appeal,
    entityId: imageId,
    status: approved ? 'Approved' : 'Rejected',
    resolvedMessage,
  });
  if (sendEmail) {
    const appellant = await dbRead
      .selectFrom('User')
      .select(['email', 'username'])
      .where('id', '=', appeal.userId)
      .executeTakeFirst();
    if (appellant?.email)
      await emailAppealResolution({
        to: appellant.email,
        username: appellant.username ?? 'User',
        approved,
        imageIds: [imageId],
      });
  }
}

/** Pairs each image with the appeal its resolution closed, dropping images whose appeal it did not. */
export function closedAppellants(
  imageIds: number[],
  closed: (ClosedAppeal | undefined)[]
): { userId: number; imageId: number }[] {
  return imageIds.flatMap((imageId, i) => {
    const appeal = closed[i];
    return appeal ? [{ userId: appeal.userId, imageId }] : [];
  });
}

export async function sendBulkAppealEmails(
  appellants: { userId: number; imageId: number }[],
  approved: boolean
): Promise<void> {
  if (!appellants.length) return;
  const byUser = new Map<number, number[]>();
  for (const { userId, imageId } of appellants) {
    const list = byUser.get(userId) ?? [];
    list.push(imageId);
    byUser.set(userId, list);
  }
  const users = await dbRead
    .selectFrom('User')
    .select(['id', 'email', 'username'])
    .where('id', 'in', [...byUser.keys()])
    .execute();
  const userMap = new Map(users.map((u) => [u.id, u]));
  for (const [userId, imageIds] of byUser) {
    const u = userMap.get(userId);
    if (u?.email)
      await emailAppealResolution({
        to: u.email,
        username: u.username ?? 'User',
        approved,
        imageIds,
      });
  }
}

export async function resolveImageAppeal({
  imageId,
  status,
  resolvedMessage,
  resolvedReason,
  internalNotes,
  userId,
  deferAppealEmail = false,
}: {
  imageId: number;
  status: AppealDecision;
  resolvedMessage?: string;
  resolvedReason: string;
  internalNotes?: string;
  userId: number;
  deferAppealEmail?: boolean;
}): Promise<ClosedAppeal | undefined> {
  const approved = status === 'Approved';

  const appeal = await closePendingAppeal(imageId, {
    status,
    resolvedBy: userId,
    resolvedMessage: resolvedMessage ?? null,
    resolvedReason,
    ...(internalNotes ? { internalNotes } : {}),
    resolvedAt: new Date(),
  });
  if (!appeal && approved && (await isHeldImage(imageId)))
    throw new AppealRestoreRefusedError(imageId);
  if (!appeal) {
    // Another resolution decided it, so this verdict must not reach the image. Only the queue flag is
    // cleared: an image flagged for appeal with no pending appeal would otherwise never leave the queue.
    await dbWrite
      .updateTable('Image')
      .set({ needsReview: null })
      .where('id', '=', imageId)
      .where('needsReview', '=', 'appeal')
      .execute();
    return undefined;
  }

  const img = await dbRead
    .selectFrom('Image')
    .select(['postId', 'pHash'])
    .where('id', '=', imageId)
    .executeTakeFirst();

  let restored = false;
  // An appeal verdict never reaches an image under the moderator-only review flag; that flag's own
  // queue decides it.
  if (status === 'Approved') {
    const { numUpdatedRows } = await dbWrite
      .updateTable('Image')
      .set({ needsReview: null, blockedFor: null, ingestion: 'Scanned' })
      .where('id', '=', imageId)
      .where('needsReview', 'is distinct from', FLAG_KEPT_THROUGH_BLOCK)
      .where('blockedFor', 'is distinct from', BLOCKED_REASON_CSAM)
      .executeTakeFirst();
    restored = numUpdatedRows > 0n;
    if (restored) {
      await dropBlockedImageDeleteQueue(imageId);
      await resetBlockedNsfwLevel(imageId);
    }
    await recompute(imageId);
    syncSearchIndex({ entityType: 'image', entityId: imageId, action: 'update' });
    if (restored) await trackImageRestore({ imageId, actorUserId: userId });
  } else {
    await dbWrite
      .updateTable('Image')
      .set({ needsReview: null })
      .where('id', '=', imageId)
      .where('needsReview', 'is distinct from', FLAG_KEPT_THROUGH_BLOCK)
      .execute();
    syncSearchIndex({ entityType: 'image', entityId: imageId, action: 'delete' });
  }

  // Restored nothing: back to Pending, with no refund and no notice, even if the revert fails.
  if (approved && !restored) {
    await dbWrite
      .updateTable('Appeal')
      .set({ status: 'Pending', resolvedBy: null, resolvedAt: null })
      .where('id', '=', appeal.id)
      .where('status', '=', 'Approved')
      .execute()
      .catch((e: Error) =>
        console.error('[resolveImageAppeal] revert to Pending failed', {
          appealId: appeal.id,
          imageId,
          error: e.message,
        })
      );
    throw new AppealRestoreRefusedError(imageId);
  }

  const postId = img?.postId ?? null;
  if (restored) await applyAcceptSideEffects({ pHash: img?.pHash ?? null, postId }, imageId);
  else await applyVisibilitySideEffects(imageId, postId);

  await runAppealCascade(appeal, imageId, approved, resolvedMessage, !deferAppealEmail);

  await recordModActivity({
    userId,
    entityType: 'image',
    entityId: imageId,
    activity: 'resolveAppeal',
  });
  return appeal;
}
