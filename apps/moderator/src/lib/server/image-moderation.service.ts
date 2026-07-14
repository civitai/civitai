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

// Image review-queue verdicts, ported from the main app's `moderateImages` / `resolveEntityAppeal`
// (image.service + report.service). Spoke owns the writes via Kysely; the ONLY main-app call is the
// Meilisearch enqueue (syncSearchIndex, fire-and-forget). Covered side effects (see
// image-moderation-effects): pHash blocklist (ClickHouse), comic re-queue, feed-existence bust,
// model-gallery cache busts (feed tags + per-version showcase cache), thumbnail-cache bust, DeleteTOS
// ClickHouse event, tos-violation notification, appeal auto-resolve, and the full appeal-resolution
// cascade — buzz refund (@civitai/buzz), entity-appeal-resolved notification, and email (@civitai/email).

const BLOCKED_REASON_MODERATED = 'moderated';

// Recompute the real nsfwLevel, then bust the thumbnail cache — mirrors the main app's updateNsfwLevel,
// which wraps the SQL fn + thumbnailCache.refresh. The cache is keyed by parentId (the video's id), so
// del `${THUMBNAILS}:${imageId}`; the reader re-fetches on miss.
const recompute = async (imageId: number) => {
  await sql`SELECT update_nsfw_levels_new(ARRAY[${imageId}::int])`.execute(dbWrite);
  await bustCachedObject(REDIS_KEYS.CACHES.THUMBNAILS, imageId);
};

// ACCEPT (unblock): clear the review flag, restore visibility, and recompute the real nsfwLevel. Ports
// handleUnblockImages for a single image. `removeMinorFlag` picks the minor-queue verdict: FALSE (plain
// "Accept") = the smart default — keep the flag for SFW, auto-clear for R+ (a minor flag on mature content
// is contradictory); TRUE ("Accept + clear minor") = force-clear even for SFW. It's a spoke-internal
// option, set only by the minor-review page's second button — the generic cross-app image-moderate action
// never sends it, so a delegated accept always gets the smart default.
export async function acceptImage({
  imageId,
  removeMinorFlag = false,
  userId,
  deferAppealEmail = false,
}: {
  imageId: number;
  removeMinorFlag?: boolean;
  userId: number;
  // Bulk callers defer the per-image appeal email; they send one deduped email per user instead.
  deferAppealEmail?: boolean;
}): Promise<void> {
  const img = await dbRead
    .selectFrom('Image')
    .select(['needsReview', 'pHash', 'postId'])
    .where('id', '=', imageId)
    .executeTakeFirst();
  if (!img) return;
  const nr = img.needsReview;

  // Strip the rule keys; on remixSource also stamp remixSourceReviewed so the audit job doesn't re-flag
  // it. COALESCE because remixSource images usually have metadata=NULL (the audit job never writes it),
  // and both `-` and `||` NULL-propagate — without it the stamp silently vanishes.
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
      // `minor` = the persistent SFW-gate. "Remove minor flag" force-clears; otherwise keep it for SFW and
      // auto-clear for R+ (nsfwLevel >= R), since a minor flag on mature content is contradictory.
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

  // Disable + clear the moderation tags that flagged the image (upsertTagsOnImageNew recomputes
  // nsfwLevel + enqueues the search sync). No review tags → do those two steps directly.
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

  // Re-admit the pHash + propagate the now-visible image to galleries/comics.
  await applyAcceptSideEffects(img, imageId);

  // If it was in appeal review, approving the image resolves the appeal — close it and run the appellant
  // cascade (refund + notify + email), same as the appeals page (legacy handleUnblockImages did this too).
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

// DELETE (block/TOS): soft-hide the image — Blocked ingestion + Blocked nsfwLevel + blockedFor. Ports
// handleBlockImages for a single image. Does NOT delete the row.
export async function blockImage({
  imageId,
  userId,
  ip,
  userAgent,
}: {
  imageId: number;
  userId: number;
  // Moderator request provenance for the DeleteTOS analytics row (optional; defaults to 'unknown').
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  const img = await dbRead
    .selectFrom('Image')
    .select(['needsReview', 'pHash', 'blockedFor', 'postId', 'nsfwLevel', 'userId'])
    .where('id', '=', imageId)
    .executeTakeFirst();
  if (!img) return; // legacy no-ops on an empty findMany — don't log activity / enqueue for a missing id.

  await dbWrite
    .updateTable('Image')
    .set({
      needsReview: null,
      ingestion: 'Blocked',
      nsfwLevel: NsfwLevel.Blocked,
      blockedFor: BLOCKED_REASON_MODERATED,
      updatedAt: new Date(),
      // On remixSource, stamp remixSourceReviewed so the audit job doesn't re-flag it (COALESCE — the
      // column is usually NULL and `||` NULL-propagates).
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

  // Everything a block cascades to (pHash blocklist, feed-existence + gallery + comic invalidation,
  // DeleteTOS analytics, owner notification) — fanned out concurrently. `img` is the pre-block row.
  await applyBlockSideEffects(img, { imageId, actorUserId: userId, ip, userAgent });
}

export type AppealDecision = 'Approved' | 'Rejected';

// The appellant cascade shared by both appeal-resolution paths (the appeals page and acceptImage's
// appeal-queue auto-approve): refund the appeal fee on approve, notify the appellant in-app, and email the
// decision. Each step is best-effort inside its effect. `appeal` must be read while still Pending (before
// the row is closed) so the buzz txn id is available.
async function runAppealCascade(
  appeal: { id: number; userId: number; buzzTransactionId: string | null },
  imageId: number,
  approved: boolean,
  resolvedMessage?: string,
  // Bulk callers pass false and send one deduped email per user via sendBulkAppealEmails instead of one
  // email per image. Refund + notify still run per-image (matching legacy, which only dedups the email).
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

// Snapshot the appellants of the pending Image appeals in `imageIds` (userId per image), read BEFORE the
// bulk resolution closes the rows. Feeds sendBulkAppealEmails so the per-user email dedup can happen after.
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

// One appeal-resolution email per appellant for a bulk resolution: group the resolved images by user and
// email each user once, listing all their items. Mirrors the legacy per-user email dedup.
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

// Resolve an image appeal. Ports resolveEntityAppeal (single image): close the pending Appeal, then on
// Approved restore the image (recompute nsfwLevel) or on Rejected just clear the appeal review flag
// (image stays blocked). Both directions flip needsReview/ingestion, so — like the legacy — both re-queue
// the parent comic(s) and bust the model galleries, then run the appellant cascade: refund the appeal fee
// on approve (buzz), notify the appellant (entity-appeal-resolved), and email them the decision.
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
  // Bulk callers defer the per-image appeal email; they send one deduped email per user instead.
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
