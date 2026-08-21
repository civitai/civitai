import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS, REDIS_SYS_KEYS, type RedisKeyTemplateSys } from '@civitai/redis';
import { env } from '$env/dynamic/private';
import { dbWrite } from './db';
import { getStorage } from './storage';
import { getSysRedis } from './redis';
import { bustCachedObject } from './cache';
import { bustPostGalleryCaches } from './image-moderation-effects';
import { syncSearchIndexBulk } from './search-index';

export async function deleteImagesByIds(ids: number[]): Promise<void> {
  const affectedPostIds = new Set<number>();
  // Only ids whose row was actually deleted — the loop `continue`s past a missing one, and de-indexing
  // an image that still exists would hide it from search while it is live on the site.
  const deleted: number[] = [];
  for (const id of ids) {
    try {
      await dbWrite.deleteFrom('CollectionItem').where('imageId', '=', id).execute();

      const image = await dbWrite
        .deleteFrom('Image')
        .where('id', '=', id)
        .returning(['url', 'postId'])
        .executeTakeFirst();
      if (!image) continue;
      // Recorded HERE, not after the S3 work below: a throw from the storage delete or the shared-url
      // check lands in the catch with the row already gone, and the id would never be de-indexed —
      // leaving a deleted image in Meilisearch.
      deleted.push(id);
      if (image.postId != null) affectedPostIds.add(image.postId);

      if (image.url) {
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
          await purgeResizeCache(image.url);
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

  void syncSearchIndexBulk({ entityType: 'image', entityIds: deleted, action: 'delete' });

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

async function purgeResizeCache(url: string): Promise<void> {
  const base = env.IMAGE_CACHER_URL;
  if (!base) return;
  await fetch(`${base}/admin/invalidate?imageKey=${encodeURIComponent(url)}`, {
    method: 'POST',
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
}
