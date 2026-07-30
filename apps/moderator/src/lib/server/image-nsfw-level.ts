import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { dbWrite } from './db';
import { bustCachedObject } from './cache';
import { syncKonoFinalize } from './kono';
import { recordModActivity } from './mod-activity';

type ReportStatus = 'Pending' | 'Processing' | 'Actioned' | 'Unactioned';

// Moderator sets an image's nsfwLevel (locks it), stamps the reason into metadata, optionally resolves its
// pending rating requests, rolls the change up to any Model3D that uses the image as its thumbnail, and
// records the mod activity. Shared by image-rating-review + downleveled-review.
//
// The main app's Meilisearch single-image index update is intentionally not mirrored here (that index
// locks specially on a single-image change).
export async function updateImageNsfwLevel({
  id,
  nsfwLevel,
  status,
  reason,
  userId,
}: {
  id: number;
  nsfwLevel: number;
  status?: ReportStatus;
  reason?: string;
  userId: number;
}): Promise<void> {
  const image = await dbWrite
    .selectFrom('Image')
    .select(['metadata', 'postId'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!image) throw new Error('Image not found');

  const metadata = {
    ...((image.metadata as Record<string, unknown> | null) ?? {}),
    nsfwLevelReason: reason ?? null,
  };

  await dbWrite
    .updateTable('Image')
    .set({
      nsfwLevel,
      nsfwLevelLocked: true,
      metadata: sql`${JSON.stringify(metadata)}::jsonb`,
    })
    .where('id', '=', id)
    .execute();

  if (status) {
    await dbWrite
      .updateTable('ImageRatingRequest')
      .set({ status })
      .where('imageId', '=', id)
      .where('status', '=', 'Pending')
      .execute();
  }

  // Roll the pinned level up to any Model3D using this image as its thumbnail. A thumbnail is always a
  // standalone image (never posted), so a posted image provably isn't one — skip the query. Model3D rows
  // with a manual nsfwLevel lock (nsfwLevel in lockedProperties) are excluded so the lock isn't clobbered.
  // Mirrors the main app's updateModel3DNsfwLevelForThumbnailImage → updateModel3DNsfwLevels.
  if (image.postId == null) {
    await sql`
      WITH level AS (
        SELECT m.id, COALESCE(i."nsfwLevel", 0) AS "nsfwLevel"
        FROM "Model3D" m
        LEFT JOIN "Image" i ON i.id = m."thumbnailImageId"
        WHERE m."thumbnailImageId" = ${id}
          AND NOT ('nsfwLevel' = ANY(m."lockedProperties"))
      ), model_update AS (
        UPDATE "Model3D" m
        SET "nsfwLevel" = level."nsfwLevel"
        FROM level
        WHERE level.id = m.id AND level."nsfwLevel" != m."nsfwLevel"
        RETURNING m.id
      )
      UPDATE "Model3DMetric" mm
      SET "nsfwLevel" = level."nsfwLevel"
      FROM level
      WHERE mm."model3dId" = level.id AND mm."nsfwLevel" != level."nsfwLevel"
    `.execute(dbWrite);
  }

  await recordModActivity({ userId, entityType: 'image', entityId: id, activity: 'setNsfwLevel' });

  // Bust the image-metadata cache so a reader re-fetches the pinned nsfwLevel/reason instead of the
  // pre-update metadata until TTL (parity with the main app's imageMetadataCache.refresh).
  await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_METADATA, id);

  // Delegate the Knights-of-New-Order finalization (finalize pending votes + smites + player counters +
  // review-pool reset + WebSocket player-stat signals) to the main app — game-engine + signals the spoke
  // can't run. Fire-and-forget, mirroring the isModerator branch of handleUpdateImageNsfwLevel.
  void syncKonoFinalize(id, nsfwLevel);
}
