import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
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
import { setAsideCounts, setAsideState } from './csam-queue-set-aside';
import type { Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// The negation of `isFlagOnlyRemaining`, written null-safe: `NOT (needsReview = x AND ...)` is NULL,
// not true, for every row with no flag, and would refuse every ordinary accept.
const NOT_FLAG_ONLY_REMAINING = sql<boolean>`("needsReview" IS DISTINCT FROM ${FLAG_KEPT_THROUGH_BLOCK} OR "ingestion" <> 'Blocked')`;

const BLOCKED_REASON_MODERATED = 'moderated';

/**
 * Mirrors the main app's `dropBlockedImageDeleteQueue`: a surviving row keeps the first block's time,
 * so this un-block's `review` activity would read as a takedown of the next block.
 */
async function dropBlockedImageDeleteQueue(imageId: number) {
  await dbWrite
    .deleteFrom('JobQueue')
    .where('type', '=', 'BlockedImageDelete')
    .where('entityType', '=', 'Image')
    .where('entityId', '=', imageId)
    .execute();
}

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

/** An accept refused because the image is removed with only the review flag left. */
export class FlagOnlyRemovedError extends Error {
  constructor(readonly imageId: number) {
    super(`Image ${imageId} is removed with only its review flag left`);
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
   *  left cannot come back live from one; they throw `FlagOnlyRemovedError` instead. */
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
    .$if(!restoreRemoved, (qb) => qb.where(NOT_FLAG_ONLY_REMAINING))
    .executeTakeFirst();
  if (!numUpdatedRows) {
    if (restoreRemoved) return;
    throw new FlagOnlyRemovedError(imageId);
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
}): Promise<{ held?: HeldRemoval }> {
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

  const { numUpdatedRows } = await dbWrite
    .updateTable('Image')
    .set({
      // The moderator-only review flag survives a block: only its own queue, a filed report or an
      // explicit unblock clears it.
      needsReview: sql<
        string | null
      >`CASE WHEN "needsReview" = ${FLAG_KEPT_THROUGH_BLOCK} THEN "needsReview" END`,
      ingestion: 'Blocked',
      nsfwLevel: NsfwLevel.Blocked,
      blockedFor: BLOCKED_REASON_MODERATED,
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
    .executeTakeFirst();
  if (!numUpdatedRows) return {};
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
  });
  return {};
}

/**
 * Takes a removed image out of the CSAM review queue as dismissed, leaving the image itself as it is:
 * flag, block and uploader untouched. False when it is not a removed, flagged image or was already
 * dismissed, e.g. another moderator got there first.
 */
export async function dismissFromCsamQueue({
  imageId,
  userId,
}: {
  imageId: number;
  userId: number;
}): Promise<boolean> {
  return dbWrite.transaction().execute(async (tx) => {
    const image = await tx
      .selectFrom('Image')
      .select('userId')
      .where('id', '=', imageId)
      .where('needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
      .where('ingestion', '=', 'Blocked')
      .forUpdate()
      .executeTakeFirst();
    if (!image) return false;
    const dismissed = await insertDismissals(tx, [{ imageId, userId: image.userId }], userId);
    return dismissed === 1;
  });
}

export type DismissUserResult =
  | { ok: true; dismissed: number; remaining: number }
  | { ok: false; reason: 'changed' | 'unavailable' };

class QueueChanged extends Error {}

/**
 * `dismissFromCsamQueue` for every one of one user's removed, flagged images not already dismissed,
 * in one transaction. `expectedCount` is what the moderator confirmed; any other number rolls back,
 * so nothing is dismissed that was not shown. `remaining` is what still needs a verdict.
 */
export async function dismissUserFromCsamQueue({
  userId,
  expectedCount,
  moderatorId,
}: {
  userId: number;
  expectedCount: number;
  moderatorId: number;
}): Promise<DismissUserResult> {
  try {
    return await dbWrite.transaction().execute(async (tx) => {
      const state = await setAsideState(tx);
      if (!state.table) return { ok: false, reason: 'unavailable' } as const;
      const images = await tx
        .selectFrom('Image as i')
        .select('i.id')
        .where('i.userId', '=', userId)
        .where('i.needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
        .where('i.ingestion', '=', 'Blocked')
        .where(sql<boolean>`not ${setAsideCounts('i', state)}`)
        .orderBy('i.id')
        .forUpdate()
        .execute();
      if (images.length !== expectedCount) throw new QueueChanged();
      const rows = images.map(({ id }) => ({ imageId: id, userId }));
      if ((await insertDismissals(tx, rows, moderatorId)) !== rows.length) throw new QueueChanged();
      const { remaining } = await tx
        .selectFrom('Image as i')
        .select(sql<number>`count(*)::int`.as('remaining'))
        .where('i.userId', '=', userId)
        .where('i.needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
        .where(sql<boolean>`not ${setAsideCounts('i', state)}`)
        .executeTakeFirstOrThrow();
      return { ok: true, dismissed: rows.length, remaining: Number(remaining) } as const;
    });
  } catch (e) {
    if (e instanceof QueueChanged) return { ok: false, reason: 'changed' };
    throw e;
  }
}

/** Writes a Dismissed row and its log entry for each image without a row. Returns how many it wrote. */
async function insertDismissals(
  tx: Transaction<DB>,
  rows: { imageId: number; userId: number }[],
  moderatorId: number
): Promise<number> {
  if (!rows.length) return 0;
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
  return inserted.length;
}

/**
 * The appeals queue reads `needsReview = 'appeal'` and the blocked-image purge spares only flagged
 * rows, so a block must leave the flag on while the appeal is Pending. A separate statement, not a
 * CASE in the block's own SET: that one re-checks under the row lock with its start-of-statement
 * snapshot, so it misses an appeal committed while it waited.
 */
async function keepPendingAppealFlag(imageId: number) {
  await dbWrite
    .updateTable('Image')
    .set({ needsReview: 'appeal' })
    .where('id', '=', imageId)
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
