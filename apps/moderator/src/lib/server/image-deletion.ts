import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS, REDIS_SYS_KEYS, type RedisKeyTemplateSys } from '@civitai/redis';
import { dbWrite } from './db';
import { getStorage } from './storage';
import { getSysRedis } from './redis';
import { bustCachedObject } from './cache';
import { bustProfilePictures, profilePictureUserIds } from './profile-picture-cache';
import { invalidateThumbnails, thumbnailParentId } from './thumbnail-cache';
import { bustPostGalleryCaches } from './image-moderation-effects';
import { syncSearchIndexBulk } from './search-index';

export async function deleteImagesByIds(ids: number[]): Promise<void> {
  const affectedPostIds = new Set<number>();
  const deleted: number[] = [];
  // No row came back: already gone, or kept by a hold marker, whose delete trigger blocks the image
  // instead. Neither is live, so both leave search with the deleted ones.
  const notReturned: number[] = [];
  const parentIds: (number | null)[] = [];
  const avatarUserIds = await profilePictureUserIds(ids).catch(() => []);
  for (const id of ids) {
    try {
      await dbWrite.deleteFrom('CollectionItem').where('imageId', '=', id).execute();

      const image = await dbWrite
        .deleteFrom('Image')
        .where('id', '=', id)
        .returning(['url', 'userId', 'postId', 'needsReview', thumbnailParentId.as('parentId')])
        .executeTakeFirst();
      if (!image) {
        notReturned.push(id);
        continue;
      }
      // Recorded HERE, not after the S3 work below: a throw from the storage delete or the shared-url
      // check lands in the catch with the row already gone, and the id would never be de-indexed —
      // leaving a deleted image in Meilisearch.
      deleted.push(id);
      parentIds.push(image.parentId);
      if (image.postId != null) affectedPostIds.add(image.postId);

      if (image.url) {
        // The main app's cdn-access-sync job stops the image serving; this app cannot reach the
        // image server's admin API. Queued whether or not the url is shared: a takedown wins.
        await queueCdnAccessForDelete({
          id,
          url: image.url,
          userId: image.userId,
          csamReview: image.needsReview === 'csam',
        });
        // Another Image may share this url; deleting the S3 object while one does would break that image.
        const shared = await dbWrite
          .selectFrom('Image')
          .select('id')
          .where('url', '=', image.url)
          .where('id', '!=', id)
          .executeTakeFirst();
        if (!shared) {
          // Every image lives in the b2Image backend.
          await getStorage()
            .deleteObject({ backend: 'b2Image', key: image.url })
            .catch((err) => console.error('[image-deletion] S3 delete failed', id, err));
        }
      }

      await getSysRedis()
        .packed.set(`${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:${id}` as RedisKeyTemplateSys, 'false', {
          EX: 60 * 5,
        })
        .catch(() => undefined);

      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_META, id);
      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_METADATA, id);
    } catch (err) {
      console.error('[image-deletion] failed to delete image', id, err);
    }
  }

  void syncSearchIndexBulk({
    entityType: 'image',
    entityIds: [...deleted, ...notReturned],
    action: 'delete',
  });
  await bustKeptImages(notReturned, affectedPostIds);
  await invalidateThumbnails(deleted, parentIds);
  await bustProfilePictures({ userIds: avatarUserIds });

  if (affectedPostIds.size) {
    const postIds = [...affectedPostIds];
    try {
      await sql`SELECT update_post_nsfw_levels(${postIds}::int[])`.execute(dbWrite);
      await bustPostGalleryCaches(postIds);
      // Don't reimplement the main app's postMetrics bucket queue here — a partial write can orphan
      // buckets; the post imageCount self-heals on the next metrics delta-scan.
    } catch (err) {
      console.error('[image-deletion] post recompute failed', postIds, err);
    }
  }
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
    console.error('[image-deletion] kept image bust failed', ids, err);
  }
}

async function queueCdnAccessForDelete({
  id,
  url,
  userId,
  csamReview,
}: {
  id: number;
  url: string;
  userId: number;
  csamReview: boolean;
}): Promise<void> {
  const payload = JSON.stringify({ url, userId, csamReview, moderatorDelete: true });
  await sql`
    SELECT queue_cdn_access_sync(${id}::int, 'Image', ${payload}::jsonb)
  `
    .execute(dbWrite)
    .catch((err) => console.error('[image-deletion] CDN takedown not queued', id, err));
}
