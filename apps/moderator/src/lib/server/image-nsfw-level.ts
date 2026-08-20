import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { dbWrite } from './db';
import { bustCachedObject } from './cache';
import { syncKonoFinalize } from './kono';
import { recordModActivity } from './mod-activity';

type ReportStatus = 'Pending' | 'Processing' | 'Actioned' | 'Unactioned';

// Don't mirror the main app's single-image Meilisearch update: that index locks specially on a single-image
// change.
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

  // Thumbnails are never posted, so a non-null postId means this image can't be a Model3D thumbnail.
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

  await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_METADATA, id);

  void syncKonoFinalize(id, nsfwLevel);
}
