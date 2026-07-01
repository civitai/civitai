// Per-user unread counter cache. Ported from the monolith's notification-cache.ts — keyed on the SAME
// redis hash (`system:notification-counts:{userId}`, field = category) via @civitai/redis's REDIS_KEYS,
// so the counts stay consistent now that this app (not the monolith) owns the read/count/mark path. A
// missing redis client (unconfigured) no-ops the counter side; the base-row queries still work.

import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import type { NotificationCategory } from '@civitai/notifications';
import { getRedis } from './clients/redis';

const NOTIFICATION_CACHE_TIME = 60 * 60 * 24 * 7; // one week

export type NotificationCategoryCount = { category: NotificationCategory; count: number };

function userKey(userId: number) {
  return `${REDIS_KEYS.SYSTEM.NOTIFICATION_COUNTS}:${userId}` as RedisKeyTemplateCache;
}

async function slideExpiration(userId: number) {
  const redis = getRedis();
  if (!redis) return;
  await redis.expire(userKey(userId), NOTIFICATION_CACHE_TIME);
}

async function hasUser(userId: number) {
  const redis = getRedis();
  if (!redis) return false;
  return await redis.exists(userKey(userId));
}

async function getUser(userId: number): Promise<NotificationCategoryCount[] | undefined> {
  const redis = getRedis();
  if (!redis) return undefined;
  const counts = await redis.hGetAll(userKey(userId));
  if (!Object.keys(counts).length) return undefined;
  return Object.entries(counts).map(([category, count]) => {
    const casted = Number(count);
    return { category: category as NotificationCategory, count: casted > 0 ? casted : 0 };
  });
}

async function setUser(userId: number, counts: NotificationCategoryCount[]) {
  const redis = getRedis();
  if (!redis) return;
  const key = userKey(userId);
  for (const { category, count } of counts) await redis.hSet(key, category, count.toString());
  await slideExpiration(userId);
}

async function incrementUser(userId: number, category: NotificationCategory, by = 1) {
  const redis = getRedis();
  if (!redis) return;
  const key = userKey(userId);
  await redis.hIncrBy(key, category, by);
  if (by < 0) {
    const value = await redis.hGet(key, category);
    if (Number(value) <= 0) await redis.hDel(key, category);
  }
}

async function decrementUser(userId: number, category: NotificationCategory, by = 1) {
  if (!(await hasUser(userId))) return;
  await incrementUser(userId, category, -by);
  await slideExpiration(userId);
}

async function bustUser(userId: number) {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(userKey(userId));
}

async function clearCategory(userId: number, category: NotificationCategory) {
  const redis = getRedis();
  if (!redis) return;
  if (!(await hasUser(userId))) return;
  await redis.hDel(userKey(userId), category);
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
