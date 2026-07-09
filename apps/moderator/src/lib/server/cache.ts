import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { getRedis } from './redis';

// Invalidate entries the main app caches via `createCachedObject` — those are stored one key per id at
// `${cacheKey}:${id}`, so deleting that key is the whole of `createCachedObject(...).bust(id)` that
// matters to a reader. A spoke write busts the SAME keys the main app reads (shared infra, not a
// callback), so the next read re-fetches from Postgres.
export async function bustCachedObject(cacheKey: string, ids: number | number[]): Promise<void> {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => id != null);
  if (!list.length) return;
  await getRedis().del(list.map((id) => `${cacheKey}:${id}` as RedisKeyTemplateCache));
}

// The three caches the main app serves image tags from — bust all of them on any image-tag write.
export async function bustImageTagCaches(ids: number | number[]): Promise<void> {
  await Promise.all([
    bustCachedObject(REDIS_KEYS.CACHES.IMAGE_TAGS, ids),
    bustCachedObject(REDIS_KEYS.CACHES.TAG_IDS_FOR_IMAGES, ids),
    bustCachedObject(REDIS_KEYS.CACHES.THUMBNAILS, ids),
  ]);
}
