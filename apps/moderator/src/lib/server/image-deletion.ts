import { sql } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REDIS_KEYS, REDIS_SYS_KEYS, type RedisKeyTemplateSys } from '@civitai/redis';
import { dbWrite } from './db';
import { getStorage } from './storage';
import { getSysRedis } from './redis';
import { bustCachedObject } from './cache';
import { bustProfilePictures, profilePictureUserIds } from './profile-picture-cache';
import { invalidateThumbnails, thumbnailParentId } from './thumbnail-cache';
import { bustPostGalleryCaches } from './image-moderation-effects';
import { syncSearchIndexBulk } from './search-index';
import { logAxiomError } from './axiom';
import { imageDeleteHeldSqlText, imageDeleteHoldLegs } from './delete-hold-sql';
import type { ImageKeptReason, KeptImage } from '$lib/image-kept-reasons';

type DeletedImage = {
  id: number;
  url: string | null;
  postId: number | null;
  parentId: number | null;
  /** Under CSAM review or blocked for CSAM: deleted by key alone, its prior versions kept. */
  csamMarked: boolean;
};

export type DeletedImageRows = {
  deleted: DeletedImage[];
  notReturned: number[];
  avatarUserIds: number[];
  /**
   * Not deleted. An `evidence` image was blocked by the hold marker's delete trigger; every other
   * one is left exactly as it was, stored file included.
   */
  refused: KeptImage[];
};

const legs = imageDeleteHoldLegs('"Image"');
const imageHeld = sql<boolean>`${sql.raw(imageDeleteHeldSqlText('"Image"'))}`;
const ownerMarked = sql<boolean>`EXISTS (
  SELECT 1 FROM "EvidenceHeldUser" marker WHERE marker."userId" = "Image"."userId"
)`;
const reviewHeld = sql<boolean>`${sql.raw(`(${legs.review} OR ${legs.block} OR ${legs.listed})`)}`;
// A marked owner's image still goes to the DELETE: the marker's trigger keeps the evidence and
// blocks the image, which a refusal alone would leave live.
const deletable = sql<boolean>`(NOT ${imageHeld} OR ${ownerMarked})`;

async function heldImages(trx: Kysely<DB>, ids: number[]): Promise<KeptImage[]> {
  if (!ids.length) return [];
  const rows = await trx
    .selectFrom('Image')
    .select(['id', ownerMarked.as('marked'), reviewHeld.as('reviewHeld')])
    .where('id', 'in', ids)
    .where(imageHeld)
    .execute();
  const reasons = new Map(
    rows.map((row): [number, ImageKeptReason] => [
      row.id,
      row.marked ? 'evidence' : row.reviewHeld ? 'review' : 'account',
    ])
  );
  return ids.flatMap((id) => {
    const reason = reasons.get(id);
    return reason ? [{ id, reason }] : [];
  });
}

/**
 * The database half of a delete, run in the caller's transaction. A follow-up that cannot be queued
 * throws, so the transaction rolls back and the image stays.
 */
export async function deleteImageRows(trx: Kysely<DB>, ids: number[]): Promise<DeletedImageRows> {
  // A hold written to one of these rows now waits for this delete rather than landing between its
  // statements; a new report listing one is still caught by the guards below.
  if (ids.length)
    await trx.selectFrom('Image').select('id').where('id', 'in', ids).forUpdate().execute();
  const untouched = (await heldImages(trx, ids)).filter((image) => image.reason !== 'evidence');
  const skip = new Set(untouched.map((image) => image.id));
  const toDelete = ids.filter((id) => !skip.has(id));
  const avatarUserIds = await profilePictureUserIds(toDelete, trx);
  const deleted: DeletedImage[] = [];
  // No row came back: already gone, kept by a hold marker's trigger, or held since the check.
  const notReturned: number[] = [];
  for (const id of toDelete) {
    // The guard is re-checked here, so a hold placed after the check above still keeps the image.
    const image = await trx
      .deleteFrom('Image')
      .where('id', '=', id)
      .where(deletable)
      .returning([
        'url',
        'userId',
        'postId',
        'needsReview',
        'blockedFor',
        thumbnailParentId.as('parentId'),
      ])
      .executeTakeFirst();
    // Only once the row is gone (no foreign key cascades these), so a kept image keeps its collections.
    await trx
      .deleteFrom('CollectionItem')
      .where('imageId', '=', id)
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM "Image" WHERE "Image".id = ${id})`)
      .execute();
    if (!image) {
      notReturned.push(id);
      continue;
    }
    if (image.url)
      // Queued whether or not the url is shared.
      await queueCdnAccessForDelete(trx, {
        id,
        url: image.url,
        userId: image.userId,
        csamReview: image.needsReview === 'csam',
      });
    deleted.push({
      id,
      url: image.url,
      postId: image.postId,
      parentId: image.parentId,
      csamMarked: image.needsReview === 'csam' || image.blockedFor === 'CSAM',
    });
  }
  const heldLate = await heldImages(trx, notReturned);
  // An untouched image keeps its search entry; one the trigger blocked leaves search.
  const untouchedLate = new Set(
    heldLate.filter((image) => image.reason !== 'evidence').map((image) => image.id)
  );
  return {
    deleted,
    notReturned: notReturned.filter((id) => !untouchedLate.has(id)),
    avatarUserIds,
    refused: [...untouched, ...heldLate],
  };
}

/**
 * Everything after the rows are gone: storage, caches, search, post levels. Best-effort; returns the
 * images whose stored file was not verified gone. Every delete here is a moderator's, so each stored
 * file goes with all its versions, except a CSAM-marked image's (see `csamMarked`).
 */
export async function finishImageDeletes({
  deleted,
  notReturned,
  avatarUserIds,
}: Omit<DeletedImageRows, 'refused'>): Promise<{ storageFailed: number[] }> {
  const affectedPostIds = new Set<number>();
  const storageFailed: number[] = [];
  for (const image of deleted) {
    if (image.postId != null) affectedPostIds.add(image.postId);
    try {
      if (image.url) {
        // Another Image may share this url; deleting the S3 object while one does would break that image.
        const shared = await dbWrite
          .selectFrom('Image')
          .select('id')
          .where('url', '=', image.url)
          .where('id', '!=', image.id)
          .executeTakeFirst();
        if (!shared) {
          // Every image lives in the b2Image backend.
          const target = { backend: 'b2Image', key: image.url } as const;
          if (image.csamMarked)
            await getStorage()
              .deleteObject(target)
              .catch((err) => {
                storageFailed.push(image.id);
                logImageDeletionError(err, 'storage delete', [image.id]);
              });
          else
            await getStorage()
              .purgeObjectVersions(target)
              .catch(async (err) => {
                storageFailed.push(image.id);
                logImageDeletionError(err, 'storage purge', [image.id]);
                await queueStorageRetry(image.id, target.key);
              });
        }
      }

      await getSysRedis()
        .packed.set(
          `${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:${image.id}` as RedisKeyTemplateSys,
          'false',
          { EX: 60 * 5 }
        )
        .catch(() => undefined);

      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_META, image.id);
      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_METADATA, image.id);
    } catch (err) {
      logImageDeletionError(err, 'cleanup', [image.id]);
    }
  }

  const deletedIds = deleted.map((image) => image.id);
  void syncSearchIndexBulk({
    entityType: 'image',
    entityIds: [...deletedIds, ...notReturned],
    action: 'delete',
  });
  await bustKeptImages(notReturned, affectedPostIds);
  await invalidateThumbnails(
    deletedIds,
    deleted.map((image) => image.parentId)
  );
  await bustProfilePictures({ userIds: avatarUserIds });

  if (affectedPostIds.size) {
    const postIds = [...affectedPostIds];
    try {
      await sql`SELECT update_post_nsfw_levels(${postIds}::int[])`.execute(dbWrite);
      await bustPostGalleryCaches(postIds);
      // Don't reimplement the main app's postMetrics bucket queue here — a partial write can orphan
      // buckets; the post imageCount self-heals on the next metrics delta-scan.
    } catch (err) {
      logImageDeletionError(err, 'post recompute', postIds);
    }
  }
  return { storageFailed };
}

/**
 * Hands a purge that did not verify to the main app's `retry-image-storage-deletes` job, the same row
 * `queueImageStorageDeleteRetry` writes there: the Image row is gone, so this key is the only way back.
 */
async function queueStorageRetry(id: number, url: string) {
  const data = JSON.stringify({ url, allVersions: true });
  await sql`
    INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
    VALUES (${id}, 'Image'::"EntityType", 'ImageStorageDelete'::"JobQueueType", ${data}::jsonb)
    ON CONFLICT ("entityType", "entityId", "type") DO UPDATE SET "data" = EXCLUDED."data"
      WHERE "JobQueue"."data"->>'url' IS DISTINCT FROM EXCLUDED."data"->>'url'
        OR (EXCLUDED."data"->>'allVersions' IS NOT NULL AND "JobQueue"."data"->>'allVersions' IS NULL)
  `
    .execute(dbWrite)
    .catch((err) => logImageDeletionError(err, 'storage retry queue', [id]));
}

function logImageDeletionError(error: unknown, step: string, imageIds: number[]) {
  void logAxiomError(error, { event: 'image-deletion', step, imageIds });
}

// A kept image is now blocked and out of its post (`EvidenceHoldImage` names the post), so its
// caches and that post's are as stale as a deleted image's.
async function bustKeptImages(ids: number[], affectedPostIds: Set<number>): Promise<void> {
  if (!ids.length) return;
  try {
    const kept = await dbWrite
      .selectFrom('EvidenceHoldImage')
      .select(['imageId', 'postId'])
      .where('imageId', 'in', ids)
      .execute();
    for (const { imageId, postId } of kept) {
      if (postId != null) affectedPostIds.add(postId);
      await getSysRedis()
        .packed.set(
          `${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:${imageId}` as RedisKeyTemplateSys,
          'false',
          { EX: 60 * 5 }
        )
        .catch(() => undefined);
      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_META, imageId);
      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_METADATA, imageId);
    }
  } catch (err) {
    logImageDeletionError(err, 'kept image bust', ids);
  }
}

async function queueCdnAccessForDelete(
  trx: Kysely<DB>,
  {
    id,
    url,
    userId,
    csamReview,
  }: {
    id: number;
    url: string;
    userId: number;
    csamReview: boolean;
  }
): Promise<void> {
  const payload = JSON.stringify({ url, userId, csamReview, moderatorDelete: true });
  await sql`
    SELECT queue_cdn_access_sync(${id}::int, 'Image', ${payload}::jsonb)
  `.execute(trx);
}
