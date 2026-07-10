import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { recordModActivity } from './mod-activity';
import { syncSearchIndex } from './search-index';
import { upsertTagsOnImageNew } from './tags-on-image.service';
import { NsfwLevel } from '@civitai/shared';

// Image review-queue verdicts, ported from the main app's `moderateImages` / `resolveEntityAppeal`
// (image.service + report.service). Spoke owns the writes via Kysely; the ONLY main-app call is the
// Meilisearch enqueue (syncSearchIndex, fire-and-forget). Infra-bound side effects the main app also
// runs — phash blocklist, tos-violation notifications, the DeleteTOS ClickHouse event (which feeds the
// appeals-queue tosReason), buzz refunds/rewards, Redis post-cache busts, emails — are deferred:
// TODO(moderator-migration).

const BLOCKED_REASON_MODERATED = 'moderated';

const recompute = (imageId: number) =>
  sql`SELECT update_nsfw_levels_new(ARRAY[${imageId}::int])`.execute(dbWrite);

// ACCEPT (unblock): clear the review flag, restore visibility, and recompute the real nsfwLevel. Ports
// handleUnblockImages for a single image. On the `minor` mode the minor flag is kept for PG/PG13 and
// cleared for R+ unless `removeMinorFlag` forces it off.
export async function acceptImage({
  imageId,
  removeMinorFlag = false,
  userId,
}: {
  imageId: number;
  removeMinorFlag?: boolean;
  userId: number;
}): Promise<void> {
  const img = await dbRead
    .selectFrom('Image')
    .select('needsReview')
    .where('id', '=', imageId)
    .executeTakeFirst();
  if (!img) return;
  const nr = img.needsReview;

  await dbWrite
    .updateTable('Image')
    .set({
      needsReview: null,
      blockedFor: null,
      ingestion: 'Scanned',
      metadata: sql`"metadata" - 'ruleId' - 'ruleReason'`,
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
}

// DELETE (block/TOS): soft-hide the image — Blocked ingestion + Blocked nsfwLevel + blockedFor. Ports
// handleBlockImages for a single image. Does NOT delete the row.
export async function blockImage({
  imageId,
  userId,
}: {
  imageId: number;
  userId: number;
}): Promise<void> {
  await dbWrite
    .updateTable('Image')
    .set({
      needsReview: null,
      ingestion: 'Blocked',
      nsfwLevel: NsfwLevel.Blocked,
      blockedFor: BLOCKED_REASON_MODERATED,
      updatedAt: new Date(),
    })
    .where('id', '=', imageId)
    .execute();

  await recordModActivity({ userId, entityType: 'image', entityId: imageId, activity: 'review' });
  syncSearchIndex({ entityType: 'image', entityId: imageId, action: 'delete' });
}

export type AppealDecision = 'Approved' | 'Rejected';

// Resolve an image appeal. Ports resolveEntityAppeal (single image): close the pending Appeal, then on
// Approved restore the image (recompute nsfwLevel) or on Rejected just clear the appeal review flag
// (image stays blocked).
export async function resolveImageAppeal({
  imageId,
  status,
  resolvedMessage,
  userId,
}: {
  imageId: number;
  status: AppealDecision;
  resolvedMessage?: string;
  userId: number;
}): Promise<void> {
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

  await recordModActivity({ userId, entityType: 'image', entityId: imageId, activity: 'resolveAppeal' });
}
