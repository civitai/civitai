import {
  createRedisCacheBuilder,
  prefixCacheKey,
  REDIS_KEYS,
  type RedisKeyTemplateCache,
} from '@civitai/redis';
import { getRedis } from './redis';

// Read-through caches for this app's own expensive reads. The mechanics — single-flight, TTL jitter,
// fail-open, named-args-as-key — live in `@civitai/redis`; this only binds them to the client shim.
//
// 🔴 Never put an in-process memo in front of one: it is filled at a different moment on every server,
// so consecutive refreshes disagree about what is still in a queue.
//
// Keeping one fresh: bust on the write when the moderator changed the thing themselves — a row they
// can click that is already resolved, or the minor-queue tab labels beside the verdict they just
// entered. Let the TTL handle what they only read: the sidebar totals cost ten queries to rebuild for
// a number nobody clicks. A bust alone is never sufficient, since a fill that started before the write
// lands after it — see `getMostReported`.
//
// The prefix carries the environment namespace that `REDIS_KEYS` gets from `applyCacheKeyPrefix` and
// these keys, built from `name`, bypass — without it a preview deployment reads and evicts production
// entries.
export const createCache = createRedisCacheBuilder({
  getClient: getRedis,
  prefix: prefixCacheKey('mod'),
});

// createCachedObject stores one key per id at `${cacheKey}:${id}`; deleting it is the whole bust. Same keys
// the main app reads.
export async function bustCachedObject(cacheKey: string, ids: number | number[]): Promise<void> {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => id != null);
  if (!list.length) return;
  await getRedis().del(list.map((id) => `${cacheKey}:${id}` as RedisKeyTemplateCache));
}

// Every UserCosmetic write needs all three. USER_COSMETICS and the COSMETICS tag back what renders on
// the profile (day TTL, no stale-while-revalidate); USER_OWNED_STICKER is checked on each message send,
// so missing it leaves a granted sticker unsendable — or a removed one still sendable — for 5 minutes.
export async function bustUserCosmeticCaches(userId: number): Promise<void> {
  await bustCachedObject(REDIS_KEYS.CACHES.USER_COSMETICS, userId);
  await bustCachedObject(REDIS_KEYS.CACHES.USER_OWNED_STICKER, userId);
  await bustCacheTag(`${REDIS_KEYS.CACHES.COSMETICS}:${userId}`);
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
