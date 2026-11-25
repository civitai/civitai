import type { Kysely, Transaction } from 'kysely';
import { sql } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
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

type ReportStatus = 'Pending' | 'Processing' | 'Actioned' | 'Unactioned';

const SONG_RATING_REFUSALS = {
  unreviewed:
    'This song has not been reviewed yet: its own scans decide it first, and are retried automatically. Rate it once they have.',
  removed: "This song was removed, so it can't be rated.",
  changed: 'This song changed while it was being rated. Reload.',
} as const;

/** Ingestion states of a song with no media to rate: removed, or its file gone. */
const REMOVED_SONG_STATES = ['Blocked', 'NotFound'];

/** A rating refused because the image is a song its own scans have not reviewed, or a removed one.
 *  Its message is the moderator-facing copy. */
export class SongRatingRefusedError extends Error {
  constructor(readonly imageId: number, readonly reason: keyof typeof SONG_RATING_REFUSALS) {
    super(SONG_RATING_REFUSALS[reason]);
  }
}

/** One piece of the work that follows a committed rating, named for its log line. */
export type AfterCommitStep = { name: string; run: () => Promise<unknown> };

type ImageNsfwLevelInput = {
  id: number;
  nsfwLevel: number;
  status?: ReportStatus;
  reason?: string;
  userId: number;
};

// Don't mirror the main app's single-image Meilisearch update: that index locks specially on a single-image
// change.
export async function updateImageNsfwLevel(input: ImageNsfwLevelInput): Promise<void> {
  // One transaction, so the level never lands without its rating-request and Model3D writes, and the
  // busts run only after a level has landed.
  const steps = await dbWrite.transaction().execute((trx) => writeImageNsfwLevel(trx, input));
  for (const step of steps) await step.run();
}

/**
 * `updateImageNsfwLevel`'s writes, on `db`: pass a transaction to commit the rating with the caller's
 * own writes. Returns the cache, activity and search work, in order, for the caller to run once that
 * commits.
 */
export async function writeImageNsfwLevel(
  db: Kysely<DB> | Transaction<DB>,
  { id, nsfwLevel, status, reason, userId }: ImageNsfwLevelInput
): Promise<AfterCommitStep[]> {
  const image = await db
    .selectFrom('Image')
    .select(['type', 'ingestion', 'metadata', 'postId', thumbnailParentId.as('parentId')])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!image) throw new Error('Image not found');
  // A locked level counts as a review in the main app's `imageReviewedSql`, which has no exception for
  // songs, and only a song's own scans may review it: so a song is rated only once they have
  // (`ingestion` Scanned). From then on its lock also stands in for a review: a rated song that a
  // failed re-scan moves to Error (`markImageScanError`) keeps counting as reviewed. A path that
  // changes a song's audio or lyrics must clear `nsfwLevelLocked`.
  if (image.type === 'audio' && image.ingestion !== 'Scanned')
    throw new SongRatingRefusedError(
      id,
      REMOVED_SONG_STATES.includes(image.ingestion) ? 'removed' : 'unreviewed'
    );

  const stored = (image.metadata as Record<string, unknown> | null) ?? {};
  const metadata = {
    ...stored,
    nsfwLevelReason: reason ?? null,
    ...ratingRecordedUnderGrace(stored, nsfwLevel),
  };

  const updated = await db
    .updateTable('Image')
    .set({
      nsfwLevel,
      nsfwLevelLocked: true,
      metadata: sql`${JSON.stringify(metadata)}::jsonb`,
    })
    .where('id', '=', id)
    // Re-checked in the write: a rescan that started since the read leaves the song unreviewed.
    .where((eb) => eb.or([eb('type', '<>', 'audio'), eb('ingestion', '=', 'Scanned')]))
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) {
    if (image.type === 'audio') throw new SongRatingRefusedError(id, 'changed');
    throw new Error('Image not found');
  }

  if (status) {
    await db
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
    `.execute(db);
  }

  const postId = image.postId;
  return [
    { name: 'image-nsfw-level-thumbnails', run: () => invalidateThumbnails(id, [image.parentId]) },
    {
      name: 'image-nsfw-level-profile-pictures',
      run: () => bustProfilePictures({ imageIds: [id] }),
    },
    {
      name: 'image-nsfw-level-activity',
      run: () =>
        recordModActivity({ userId, entityType: 'image', entityId: id, activity: 'setNsfwLevel' }),
    },
    {
      name: 'image-nsfw-level-cache-bust',
      run: () =>
        bustAfterWrite('image-nsfw-level-cache-bust', () =>
          Promise.all([
            bustCachedObject(REDIS_KEYS.CACHES.IMAGE_METADATA, id),
            // The version showcase is cached for a day and filtered by level when it is built.
            bustPostGalleryCaches(postId != null ? [postId] : []),
          ])
        ),
    },
    ...(postId != null
      ? [
          {
            name: 'image-nsfw-level-search',
            run: () => queueDocumentsForImageMinorChanges({ levelImageIds: [id] }),
          },
        ]
      : []),
  ];
}
