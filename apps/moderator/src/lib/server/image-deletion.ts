import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS, REDIS_SYS_KEYS, type RedisKeyTemplateSys } from '@civitai/redis';
import { env } from '$env/dynamic/private';
import { dbWrite } from './db';
import { getStorage } from './storage';
import { getSysRedis } from './redis';
import { bustCachedObject } from './cache';
import { bustPostGalleryCaches } from './image-moderation-effects';
import { syncSearchIndex } from './search-index';

// Full image delete — the spoke port of the main app's `deleteImageById` (image.service.ts:388): remove the
// image from all collections, delete the Image row, delete the S3 object (via @civitai/storage), de-index it
// from Meilisearch (both image + metrics indexes, handled main-app-side by the 'image' delete enqueue), and
// bust the existence + meta caches. Per-image and best-effort: a failed cleanup step is logged and never
// aborts the rest (a half-deleted image left indexed is worse than a noisy log).
//
// For any deleted image that belonged to a post, the post is recomputed afterward (nsfwLevel + gallery
// caches), mirroring deleteImageById's updatePost branch — see the post-cleanup block after the loop.
//
// Verified: all images (oldest → newest) live in the `b2Image` backend — confirmed via the storage app's
// `head` on real keys — so the hardcoded backend is correct. The storage app only deletes the S3 object, so
// the resize/CDN purge is replicated here (purgeResizeCache, below).
export async function deleteImagesByIds(ids: number[]): Promise<void> {
  const affectedPostIds = new Set<number>();
  for (const id of ids) {
    try {
      // Remove from all collections first (parity with removeEntityFromAllCollections('image', id)).
      await dbWrite.deleteFrom('CollectionItem').where('imageId', '=', id).execute();

      const image = await dbWrite
        .deleteFrom('Image')
        .where('id', '=', id)
        .returning(['url', 'postId'])
        .executeTakeFirst();
      if (!image) continue;
      if (image.postId != null) affectedPostIds.add(image.postId);

      // S3: skip if another Image shares the same url (dedup, matching deleteImageFromS3), else delete it.
      if (image.url) {
        const shared = await dbWrite
          .selectFrom('Image')
          .select('id')
          .where('url', '=', image.url)
          .where('id', '!=', id)
          .executeTakeFirst();
        if (!shared) {
          await getStorage()
            .deleteObject({ backend: 'b2Image', key: image.url })
            .catch((err) => console.error('[image-deletion] S3 delete failed', id, err));
          await purgeResizeCache(image.url);
        }
      }

      // Meilisearch delete (main app handles both the image and image-metrics indexes on 'image' delete).
      void syncSearchIndex({ entityType: 'image', entityId: id, action: 'delete' });

      // Existence cache → false (parity with invalidateManyImageExistence).
      await getSysRedis()
        .packed.set(
          `${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:${id}` as RedisKeyTemplateSys,
          'false',
          { EX: 60 * 5 }
        )
        .catch(() => undefined);

      // Bust the image meta caches (deleting is correct for a gone image; the main app refreshes).
      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_META, id);
      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_METADATA, id);
    } catch (err) {
      console.error('[image-deletion] failed to delete image', id, err);
    }
  }

  // Recompute every post that lost an image, then bust its model-gallery caches so the deleted image drops
  // out immediately — parity with deleteImageById's updatePost branch (updatePostNsfwLevel +
  // bustCachesForPosts). Runs once for the whole batch. postMetrics.queueUpdate is intentionally not
  // mirrored: it enqueues to the main app's bucket-based metric queue (unsafe to partially reimplement — a
  // wrong write can orphan buckets), and the post's imageCount self-heals on the next metrics delta-scan.
  if (affectedPostIds.size) {
    const postIds = [...affectedPostIds];
    try {
      await sql`SELECT update_post_nsfw_levels(${postIds}::int[])`.execute(dbWrite);
      await bustPostGalleryCaches(postIds);
    } catch (err) {
      console.error('[image-deletion] post recompute failed', postIds, err);
    }
  }
}

// Invalidate the image-cacher's resized/converted variants for a deleted image — parity with the main app's
// purgeResizeCache: a best-effort POST to the image-cacher, which owns the L2 Redis + Cloudflare tag purge.
// Fire-and-forget with a short timeout; a stale variant self-heals and must never fail the delete. No-ops
// when IMAGE_CACHER_URL is unset (as in local dev, matching the main app).
async function purgeResizeCache(url: string): Promise<void> {
  const base = env.IMAGE_CACHER_URL;
  if (!base) return;
  await fetch(`${base}/admin/invalidate?imageKey=${encodeURIComponent(url)}`, {
    method: 'POST',
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
}
