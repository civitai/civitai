import { CacheTTL } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { redis, REDIS_KEYS, RedisKeyTemplateCache } from '~/server/redis/client';

// #region Notification Cache
const NOTIFICATION_CACHE_TIME = CacheTTL.week;
export type NotificationCategoryCount = {
  category: NotificationCategory;
  count: number;
};

function getUserKey(userId: number) {
  return `${REDIS_KEYS.SYSTEM.NOTIFICATION_COUNTS}:${userId}` as RedisKeyTemplateCache;
}

async function getUser(userId: number) {
  const key = `${REDIS_KEYS.SYSTEM.NOTIFICATION_COUNTS}:${userId}` as const;
  const counts = await redis.hGetAll(key);
  if (!Object.keys(counts).length) return undefined;
  return Object.entries(counts).map(([category, count]) => {
    const castedCount = Number(count);
    return {
      category: category as NotificationCategory,
      count: castedCount > 0 ? castedCount : 0,
    };
  }) as NotificationCategoryCount[];
}

async function setUser(userId: number, counts: NotificationCategoryCount[]) {
  const key = getUserKey(userId);
  for (const { category, count } of counts) await redis.hSetNX(key, category, count.toString());
  await slideExpiration(userId);
}

async function incrementUser(userId: number, category: NotificationCategory, by = 1) {
  const key = getUserKey(userId);
  await redis.hIncrBy(key, category, by);
  if (by < 0) {
    const value = await redis.hGet(key, category);
    if (Number(value) <= 0) await redis.hDel(key, category);
  }
}

async function decrementUser(userId: number, category: NotificationCategory, by = 1) {
  if (!(await hasUser(userId))) return;
  // logToAxiom({ type: 'decrementUser', userId, category }, 'webhooks').catch();
  await incrementUser(userId, category, -by);
  await slideExpiration(userId);
}

async function bustUser(userId: number) {
  const key = getUserKey(userId);
  await redis.del(key);
}

async function clearCategory(userId: number, category: NotificationCategory) {
  const key = getUserKey(userId);
  if (!(await hasUser(userId))) return;
  await redis.hDel(key, category);
  await slideExpiration(userId);
}

async function hasUser(userId: number) {
  const key = getUserKey(userId);
  return await redis.exists(key);
}

async function slideExpiration(userId: number) {
  const key = getUserKey(userId);
  await redis.expire(key, NOTIFICATION_CACHE_TIME);
}

export const notificationCache = {
  getUser,
  setUser,
  incrementUser,
  decrementUser,
  clearCategory,
  bustUser,
};
// #endregion
