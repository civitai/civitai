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

type DeletedImage = {
  id: number;
  url: string | null;
  postId: number | null;
  parentId: number | null;
};

export type DeletedImageRows = { deleted: DeletedImage[]; notReturned: number[] };

/**
 * The database half of a delete, run in the caller's transaction. A follow-up that cannot be queued
 * throws, so the transaction rolls back and the image stays.
 */
export async function deleteImageRows(trx: Kysely<DB>, ids: number[]): Promise<DeletedImageRows> {
  const deleted: DeletedImage[] = [];
  // No row came back: already gone, or kept by a hold marker, whose delete trigger blocks the image
  // instead. Neither is live, so both leave search with the deleted ones.
  const notReturned: number[] = [];
  for (const id of ids) {
    await trx.deleteFrom('CollectionItem').where('imageId', '=', id).execute();
    const image = await trx
      .deleteFrom('Image')
      .where('id', '=', id)
      .returning(['url', 'userId', 'postId', 'needsReview', thumbnailParentId.as('parentId')])
      .executeTakeFirst();
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
    deleted.push({ id, url: image.url, postId: image.postId, parentId: image.parentId });
  }
  return { deleted, notReturned };
}

/** Everything after the rows are gone: storage, caches, search, post levels. Best-effort. */
export async function finishImageDeletes(
  { deleted, notReturned }: DeletedImageRows,
  avatarUserIds: number[]
): Promise<void> {
  const affectedPostIds = new Set<number>();
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
          await getStorage()
            .deleteObject({ backend: 'b2Image', key: image.url })
            .catch((err) => logImageDeletionError(err, 'storage delete', [image.id]));
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
}

/** Deletes each image in its own transaction; throws, after the rest are done, if any failed. */
export async function deleteImagesByIds(ids: number[]): Promise<void> {
  const avatarUserIds = await profilePictureUserIds(ids).catch(() => []);
  const rows: DeletedImageRows = { deleted: [], notReturned: [] };
  const failed: number[] = [];
  for (const id of ids) {
    try {
      const one = await dbWrite.transaction().execute((trx) => deleteImageRows(trx, [id]));
      rows.deleted.push(...one.deleted);
      rows.notReturned.push(...one.notReturned);
    } catch (err) {
      failed.push(id);
      logImageDeletionError(err, 'delete', [id]);
    }
  }
  await finishImageDeletes(rows, avatarUserIds);
  if (failed.length) throw new Error(`Could not delete image(s) ${failed.join(', ')}; try again`);
}

function logImageDeletionError(error: unknown, step: string, imageIds: number[]) {
  void logAxiomError(error, { name: 'image-deletion', step, imageIds });
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
