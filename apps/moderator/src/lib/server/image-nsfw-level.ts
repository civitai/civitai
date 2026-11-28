import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { dbWrite } from './db';
import { bustCachedObject } from './cache';
import { bustAfterWrite } from './bust-after-write';
import { bustPostGalleryCaches } from './image-moderation-effects';
import { bustProfilePictures } from './profile-picture-cache';
import { invalidateThumbnails, thumbnailParentId } from './thumbnail-cache';
import { recordModActivity } from './mod-activity';
import { queueDocumentsForImageMinorChanges } from './image-models-reindex';
import { ratingRecordedUnderGrace } from '@civitai/shared/account-deletion-grace';
import { assertNotWithheld, notWithheldTarget } from './withheld-write';
import { blockMarkerText } from '@civitai/db-queries/profile-picture-clear';
import { NsfwLevel } from '@civitai/shared';

/** A rating write refused because the image carries a block: it takes a lift first. */
export class BlockedImageRatingError extends Error {
  constructor(imageId: number) {
    super(`Image ${imageId} is blocked: lift the block before rating it.`);
    this.name = 'BlockedImageRatingError';
  }
}

type ReportStatus = 'Pending' | 'Processing' | 'Actioned' | 'Unactioned';

// Don't mirror the main app's single-image Meilisearch update: that index locks specially on a single-image
// change.
export async function updateImageNsfwLevel({
  id,
  nsfwLevel,
  status,
  reason,
  userId,
  csamReview,
}: {
  id: number;
  nsfwLevel: number;
  status?: ReportStatus;
  reason?: string;
  userId: number;
  /** The moderator's CSAM grant: an image withheld from them is left as it is, and this throws
   *  `WithheldImageError`. */
  csamReview: boolean;
}): Promise<void> {
  const image = await dbWrite
    .selectFrom('Image')
    .select(['metadata', 'postId', thumbnailParentId.as('parentId')])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!image) throw new Error('Image not found');

  const stored = (image.metadata as Record<string, unknown> | null) ?? {};
  const metadata = {
    ...stored,
    nsfwLevelReason: reason ?? null,
    ...ratingRecordedUnderGrace(stored, nsfwLevel),
  };

  const written = await dbWrite
    .updateTable('Image')
    .set({
      nsfwLevel,
      nsfwLevelLocked: true,
      metadata: sql`${JSON.stringify(metadata)}::jsonb`,
    })
    .where('id', '=', id)
    .where(notWithheldTarget(csamReview))
    // A blocked image keeps its Blocked level until a lift; rating it Blocked again is allowed.
    .$if(nsfwLevel !== NsfwLevel.Blocked, (qb) =>
      qb.where(sql<boolean>`NOT ${sql.raw(blockMarkerText('"Image"'))}`)
    )
    .executeTakeFirst();
  if (Number(written.numUpdatedRows) === 0) {
    await assertNotWithheld([id], csamReview);
    const stillThere = await dbWrite
      .selectFrom('Image')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!stillThere) throw new Error('Image not found');
    throw new BlockedImageRatingError(id);
  }
  if (status) {
    await dbWrite
      .updateTable('ImageRatingRequest')
      .set({ status })
      .where('imageId', '=', id)
      .where('status', '=', 'Pending')
      .execute();
  }
  await invalidateThumbnails(id, [image.parentId]);
  await bustProfilePictures({ imageIds: [id] });

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

  await bustAfterWrite('image-nsfw-level-cache-bust', () =>
    Promise.all([
      bustCachedObject(REDIS_KEYS.CACHES.IMAGE_METADATA, id),
      // The version showcase is cached for a day and filtered by level when it is built.
      bustPostGalleryCaches(image.postId != null ? [image.postId] : []),
    ])
  );

  if (image.postId != null) await queueDocumentsForImageMinorChanges({ levelImageIds: [id] });
}
