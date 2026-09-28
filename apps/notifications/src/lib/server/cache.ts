// Per-user unread counter cache. Ported from the monolith's notification-cache.ts — keyed on the SAME
// redis hash (`system:notification-counts:{userId}`, field = category) via @civitai/redis's REDIS_KEYS,
// so the counts stay consistent now that this app (not the monolith) owns the read/count/mark path. A
// missing redis client (unconfigured) no-ops the counter side; the base-row queries still work.

import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import type { NotificationCategory } from '@civitai/notifications';
import { getRedis } from './clients/redis';
import { redisErrorsTotal } from './metrics';

const NOTIFICATION_CACHE_TIME = 60 * 60 * 24 * 7; // one week
// Written only by setUser, in the same EVAL as the counts. A hash without it was assembled by increments
// (or by a build before this field existed) and is not the user's whole count. Its value is "0" so a build
// that doesn't know the field reads it as an empty category rather than adding to the badge.
const COMPLETE_FIELD = '__complete';

export type NotificationCategoryCount = { category: NotificationCategory; count: number };

function userKey(userId: number) {
  return `${REDIS_KEYS.SYSTEM.NOTIFICATION_COUNTS}:${userId}` as RedisKeyTemplateCache;
}

/**
 * Count-and-rethrow wrapper for redis cache ops. Behavior is unchanged — an error still propagates to the
 * caller exactly as before (callers that already `.catch()` keep degrading to no-op) — this only makes an
 * otherwise-silent redis failure scrapeable via `notifications_redis_errors_total{operation}`.
 */
async function withRedisErrorCount<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    redisErrorsTotal.inc({ operation });
    throw err;
  }
}

async function slideExpiration(userId: number) {
  const redis = getRedis();
  if (!redis) return;
  await withRedisErrorCount('set', () => redis.expire(userKey(userId), NOTIFICATION_CACHE_TIME));
}

async function hasUser(userId: number) {
  const redis = getRedis();
  if (!redis) return false;
  return await withRedisErrorCount('has', () => redis.exists(userKey(userId)));
}

async function getUser(userId: number): Promise<NotificationCategoryCount[] | undefined> {
  const redis = getRedis();
  if (!redis) return undefined;
  const { [COMPLETE_FIELD]: complete, ...counts } = await withRedisErrorCount('get', () =>
    redis.hGetAll(userKey(userId))
  );
  if (complete === undefined) {
    // Bust rather than overwrite: setUser merges, so a stale category the recount no longer returns would
    // otherwise survive under the new marker.
    if (Object.keys(counts).length) await bustUser(userId);
    return undefined;
  }
  return Object.entries(counts).map(([category, count]) => {
    const casted = Number(count);
    return { category: category as NotificationCategory, count: casted > 0 ? casted : 0 };
  });
}

async function setUser(userId: number, counts: NotificationCategoryCount[]) {
  const redis = getRedis();
  if (!redis) return;
  const fields = [
    COMPLETE_FIELD,
    '0',
    ...counts.flatMap(({ category, count }) => [category, count.toString()]),
  ];
  await withRedisErrorCount('set', () =>
    redis.hSetMultiWithExpire(userKey(userId), fields, NOTIFICATION_CACHE_TIME)
  );
}

// HINCRBY on an absent key creates a hash holding only this category. getUser would refuse it, but
// skipping it saves the round trips of writing and then busting it.
async function incrementUser(userId: number, category: NotificationCategory, by = 1) {
  const redis = getRedis();
  if (!redis) return;
  if (!(await hasUser(userId))) return;
  const key = userKey(userId);
  await withRedisErrorCount('increment', async () => {
    await redis.hIncrBy(key, category, by);
    if (by < 0) {
      const value = await redis.hGet(key, category);
      if (Number(value) <= 0) await redis.hDel(key, category);
    }
  });
}

async function decrementUser(userId: number, category: NotificationCategory, by = 1) {
  await incrementUser(userId, category, -by);
  await slideExpiration(userId);
}

async function bustUser(userId: number) {
  const redis = getRedis();
  if (!redis) return;
  await withRedisErrorCount('bustUser', () => redis.del(userKey(userId)));
}

async function clearCategory(userId: number, category: NotificationCategory) {
  const redis = getRedis();
  if (!redis) return;
  if (!(await hasUser(userId))) return;
  await withRedisErrorCount('clearCategory', () => redis.hDel(userKey(userId), category));
  await slideExpiration(userId);
}

export const notificationCache = {
  getUser,
  setUser,
  incrementUser,
  decrementUser,
  clearCategory,
  bustUser,
};
