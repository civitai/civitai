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
import { bustCachedObject } from './cache';
import { REDIS_KEYS } from '@civitai/redis';
import { NsfwLevel } from '@civitai/shared';

const BLOCKED_REASON_MODERATED = 'moderated';

const recompute = async (imageId: number) => {
  await sql`SELECT update_nsfw_levels_new(ARRAY[${imageId}::int])`.execute(dbWrite);
  await bustCachedObject(REDIS_KEYS.CACHES.THUMBNAILS, imageId);
};

export async function acceptImage({
  imageId,
  removeMinorFlag = false,
  userId,
  deferAppealEmail = false,
}: {
  imageId: number;
  removeMinorFlag?: boolean;
  userId: number;
  deferAppealEmail?: boolean;
}): Promise<void> {
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

  await dbWrite
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
    .execute();

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
    // upsertTagsOnImageNew does NOT bust the thumbnail cache (recompute() does), so bust it here or an
    // unblocked thumbnail-child image serves a stale Blocked level until TTL.
    await bustCachedObject(REDIS_KEYS.CACHES.THUMBNAILS, imageId);
  } else {
    await recompute(imageId);
    syncSearchIndex({ entityType: 'image', entityId: imageId, action: 'update' });
  }

  await recordModActivity({ userId, entityType: 'image', entityId: imageId, activity: 'review' });

  await applyAcceptSideEffects(img, imageId);

  if (nr === 'appeal') {
    const appeal = await dbRead
      .selectFrom('Appeal')
      .select(['id', 'userId', 'buzzTransactionId'])
      .where('entityType', '=', 'Image')
      .where('entityId', '=', imageId)
      .where('status', '=', 'Pending')
      .executeTakeFirst();
    await dbWrite
      .updateTable('Appeal')
      .set({ status: 'Approved', resolvedBy: userId, resolvedAt: new Date() })
      .where('entityType', '=', 'Image')
      .where('entityId', '=', imageId)
      .where('status', '=', 'Pending')
      .execute();
    if (appeal) await runAppealCascade(appeal, imageId, true, undefined, !deferAppealEmail);
  }
}

export async function blockImage({
  imageId,
  userId,
  ip,
  userAgent,
}: {
  imageId: number;
  userId: number;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  const img = await dbRead
    .selectFrom('Image')
    .select(['needsReview', 'pHash', 'blockedFor', 'postId', 'nsfwLevel', 'userId'])
    .where('id', '=', imageId)
    .executeTakeFirst();
  if (!img) return;

  await dbWrite
    .updateTable('Image')
    .set({
      needsReview: null,
      ingestion: 'Blocked',
      nsfwLevel: NsfwLevel.Blocked,
      blockedFor: BLOCKED_REASON_MODERATED,
      updatedAt: new Date(),
      // remixSource: COALESCE guards the usual metadata=NULL — `||` NULL-propagates, dropping the stamp.
      ...(img.needsReview === 'remixSource'
        ? {
            metadata: sql`COALESCE("metadata", '{}'::jsonb) || '{"remixSourceReviewed": true}'::jsonb`,
          }
        : {}),
    })
    .where('id', '=', imageId)
    .execute();

  await recordModActivity({ userId, entityType: 'image', entityId: imageId, activity: 'review' });
  syncSearchIndex({ entityType: 'image', entityId: imageId, action: 'delete' });

  // `img` is the pre-block row (read above, before the update).
  await applyBlockSideEffects(img, { imageId, actorUserId: userId, ip, userAgent });
}

export type AppealDecision = 'Approved' | 'Rejected';

// `appeal` must be read while still Pending (before the row is closed) — the buzz txn id is needed here.
async function runAppealCascade(
  appeal: { id: number; userId: number; buzzTransactionId: string | null },
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
    userId: appeal.userId,
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

// Call BEFORE the bulk resolution closes the rows — the status='Pending' filter needs them still open.
export async function getPendingImageAppealAppellants(
  imageIds: number[]
): Promise<{ userId: number; imageId: number }[]> {
  if (!imageIds.length) return [];
  const rows = await dbRead
    .selectFrom('Appeal')
    .select(['userId', 'entityId'])
    .where('entityType', '=', 'Image')
    .where('entityId', 'in', imageIds)
    .where('status', '=', 'Pending')
    .execute();
  return rows.map((r) => ({ userId: r.userId, imageId: r.entityId }));
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
  userId,
  deferAppealEmail = false,
}: {
  imageId: number;
  status: AppealDecision;
  resolvedMessage?: string;
  userId: number;
  deferAppealEmail?: boolean;
}): Promise<void> {
  const approved = status === 'Approved';

  // Read the pending appeal (appellant + buzz txn) BEFORE closing it — the cascade below needs them.
  const appeal = await dbRead
    .selectFrom('Appeal')
    .select(['id', 'userId', 'buzzTransactionId'])
    .where('entityType', '=', 'Image')
    .where('entityId', '=', imageId)
    .where('status', '=', 'Pending')
    .executeTakeFirst();

  await dbWrite
    .updateTable('Appeal')
    .set({
      status,
      resolvedBy: userId,
      resolvedMessage: resolvedMessage ?? null,
      resolvedAt: new Date(),
    })
    .where('entityType', '=', 'Image')
    .where('entityId', '=', imageId)
    .where('status', '=', 'Pending')
    .execute();

  const img = await dbRead
    .selectFrom('Image')
    .select('postId')
    .where('id', '=', imageId)
    .executeTakeFirst();

  if (status === 'Approved') {
    await dbWrite
      .updateTable('Image')
      .set({ needsReview: null, blockedFor: null, ingestion: 'Scanned' })
      .where('id', '=', imageId)
      .execute();
    await recompute(imageId);
    syncSearchIndex({ entityType: 'image', entityId: imageId, action: 'update' });
  } else {
    await dbWrite
      .updateTable('Image')
      .set({ needsReview: null })
      .where('id', '=', imageId)
      .execute();
    syncSearchIndex({ entityType: 'image', entityId: imageId, action: 'delete' });
  }

  await applyVisibilitySideEffects(imageId, img?.postId ?? null);

  if (appeal) await runAppealCascade(appeal, imageId, approved, resolvedMessage, !deferAppealEmail);

  await recordModActivity({
    userId,
    entityType: 'image',
    entityId: imageId,
    activity: 'resolveAppeal',
  });
}
