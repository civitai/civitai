import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { recordModActivity } from './mod-activity';
import { syncSearchIndex } from './search-index';
import { upsertTagsOnImageNew } from './tags-on-image.service';
import {
  applyBlockSideEffects,
  applyAcceptSideEffects,
  applyVisibilitySideEffects,
  refundAppealFee,
  notifyAppealResolved,
  emailAppealResolution,
} from './image-moderation-effects';
import { invalidateThumbnails, thumbnailParentId } from './thumbnail-cache';
import { NsfwLevel } from '@civitai/shared';
import { FLAG_KEPT_THROUGH_BLOCK } from '$lib/image-review';

// The negation of `isFlagOnlyRemaining`, written null-safe: `NOT (needsReview = x AND ...)` is NULL,
// not true, for every row with no flag, and would refuse every ordinary accept.
const NOT_FLAG_ONLY_REMAINING = sql<boolean>`("needsReview" IS DISTINCT FROM ${FLAG_KEPT_THROUGH_BLOCK} OR "ingestion" <> 'Blocked')`;

const BLOCKED_REASON_MODERATED = 'moderated';

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
};

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
    .select(['needsReview', 'pHash', 'postId'])
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

  // update_nsfw_levels_new skips nsfwLevelLocked rows, so without this a rating-locked Blocked image would
  // stay hidden after unblock. Clear the lock + zero the level so the recompute below restores the real one.
  await dbWrite
    .updateTable('Image')
    .set({ nsfwLevel: 0, nsfwLevelLocked: false })
    .where('id', '=', imageId)
    .where('nsfwLevel', '=', NsfwLevel.Blocked)
    .execute();

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

export async function blockImage({
  imageId,
  userId,
  ip,
  userAgent,
  violationType,
  violationDetails,
}: {
  imageId: number;
  userId: number;
  ip?: string;
  userAgent?: string;
  violationType?: string;
  violationDetails?: string;
}): Promise<void> {
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
  if (!img) return;

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
  if (!numUpdatedRows) return;
  await keepPendingAppealFlag(imageId);
  await invalidateThumbnails(imageId, [img.parentId]);

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
}

/**
 * Clears the moderator-only review flag from an image that stays Blocked: no unblock, no notice to
 * the uploader. False when there was nothing to clear, e.g. another moderator got there first.
 */
export async function dismissReviewFlag({
  imageId,
  userId,
}: {
  imageId: number;
  userId: number;
}): Promise<boolean> {
  const { numUpdatedRows } = await dbWrite
    .updateTable('Image')
    .set({ needsReview: null })
    .where('id', '=', imageId)
    .where('needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
    .where('ingestion', '=', 'Blocked')
    .executeTakeFirst();
  if (!numUpdatedRows) return false;

  // Never one of the main app's MODERATOR_TAKEDOWN_ACTIVITIES: clearing a flag is not a decision to
  // destroy the image, and those values license exactly that.
  await recordModActivity({
    userId,
    entityType: 'image',
    entityId: imageId,
    activity: 'dismissReviewFlag',
  });
  return true;
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
  return dbWrite
    .updateTable('Appeal')
    .set(decision)
    .where('entityType', '=', 'Image')
    .where('entityId', '=', imageId)
    .where('status', '=', 'Pending')
    .returning(['id', 'userId', 'buzzTransactionId'])
    .executeTakeFirst();
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
    .select('postId')
    .where('id', '=', imageId)
    .executeTakeFirst();

  // An appeal verdict never reaches an image under the moderator-only review flag; that flag's own
  // queue decides it.
  if (status === 'Approved') {
    await dbWrite
      .updateTable('Image')
      .set({ needsReview: null, blockedFor: null, ingestion: 'Scanned' })
      .where('id', '=', imageId)
      .where('needsReview', 'is distinct from', FLAG_KEPT_THROUGH_BLOCK)
      .execute();
    await recompute(imageId);
    syncSearchIndex({ entityType: 'image', entityId: imageId, action: 'update' });
  } else {
    await dbWrite
      .updateTable('Image')
      .set({ needsReview: null })
      .where('id', '=', imageId)
      .where('needsReview', 'is distinct from', FLAG_KEPT_THROUGH_BLOCK)
      .execute();
    syncSearchIndex({ entityType: 'image', entityId: imageId, action: 'delete' });
  }

  await applyVisibilitySideEffects(imageId, img?.postId ?? null);

  await runAppealCascade(appeal, imageId, approved, resolvedMessage, !deferAppealEmail);

  await recordModActivity({
    userId,
    entityType: 'image',
    entityId: imageId,
    activity: 'resolveAppeal',
  });
  return appeal;
}
