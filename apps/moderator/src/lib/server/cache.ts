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

// Port of the main app's bustCacheTag. getAllImages caches under tags (`images-modelVersion:X`, …); each
// tag is a Redis SET at `${TAG}:${tag}` holding the cache keys tagged with it. Delete every member key,
// then the set. Use plain `sMembers`/`del` (NOT packed) — tagCacheKey writes raw strings via sAdd, so a
// packed read would msgpack-decode and throw.
export async function bustCacheTag(tag: string | string[]): Promise<void> {
  const tags = Array.isArray(tag) ? tag : [tag];
  const redis = getRedis();
  for (const t of tags) {
    const setKey = `${REDIS_KEYS.TAG}:${t}` as RedisKeyTemplateCache;
    const keys = await redis.sMembers<RedisKeyTemplateCache>(setKey);
    for (const key of keys) await redis.del(key);
    await redis.del(setKey);
  }
}
