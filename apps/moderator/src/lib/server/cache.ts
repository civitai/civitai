import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { getRedis } from './redis';

// createCachedObject stores one key per id at `${cacheKey}:${id}`; deleting it is the whole bust. Same keys
// the main app reads.
export async function bustCachedObject(cacheKey: string, ids: number | number[]): Promise<void> {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => id != null);
  if (!list.length) return;
  await getRedis().del(list.map((id) => `${cacheKey}:${id}` as RedisKeyTemplateCache));
}

export async function bustImageTagCaches(ids: number | number[]): Promise<void> {
  await Promise.all([
    bustCachedObject(REDIS_KEYS.CACHES.IMAGE_TAGS, ids),
    bustCachedObject(REDIS_KEYS.CACHES.TAG_IDS_FOR_IMAGES, ids),
    bustCachedObject(REDIS_KEYS.CACHES.THUMBNAILS, ids),
  ]);
}

// Each tag is a Redis SET at `${TAG}:${tag}` of the cache keys tagged with it — delete the members, then the
// set. Use plain sMembers/del (NOT packed): the writer stores raw strings, so a packed read would throw.
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
