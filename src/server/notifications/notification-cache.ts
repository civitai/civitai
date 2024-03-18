import { NotificationCategory } from '@prisma/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';

// #region Notification Counter
export type NotificationAddedRow = { category: NotificationCategory; userId: number };
type NotificationCategoryCounts = Partial<Record<NotificationCategory, number>>;
export function createNotificationCounter() {
  let increments: Record<number, NotificationCategoryCounts> = {};

  function add(data: { userId: number; category: NotificationCategory }[]) {
    for (const { userId, category } of data) {
      increments[userId] ??= {};
      increments[userId][category] ??= 0;
      increments[userId][category]!++;
    }
  }

  async function save() {
    const toIncrement: [number, NotificationCategory, number][] = [];
    for (const [userIdString, categoryCounts] of Object.entries(increments)) {
      const userId = Number(userIdString);
      const isCached = await hasUser(userId);
      if (!isCached) continue;

      for (const [category, count] of Object.entries(categoryCounts))
        toIncrement.push([userId, category as NotificationCategory, count]);
    }

    // Do it here so that we can capture it all in a single pipeline
    // node-redis pipelines are automatic when it can be
    // and so to make that happen we need to do this here
    // since we did an `exists` check above
    for (const args of toIncrement) await incrementUser(...args);

    increments = {};
  }

  return {
    add,
    save,
  };
}

export async function withNotificationCounter(
  fn: (counter: ReturnType<typeof createNotificationCounter>) => Promise<any> | any,
  onError?: (e: Error) => void
) {
  const counter = createNotificationCounter();
  try {
    return await fn(counter);
  } catch (e) {
    onError?.(e as Error);
  } finally {
    const start = Date.now();
    await counter.save();
    logToAxiom(
      {
        name: 'notification-counter',
        type: 'info',
        message: 'Save notification counts',
        duration: Date.now() - start,
      },
      'webhooks'
    ).catch();
  }
}
// #endregion

// #region Notification Cache
const NOTIFICATION_CACHE_TIME = CacheTTL.week;
export type NotificationCategoryArray = {
  category: NotificationCategory;
  count: number;
}[];

function getUserKey(userId: number) {
  return `${REDIS_KEYS.SYSTEM.NOTIFICATION_COUNTS}:${userId}`;
}

async function getUser(userId: number) {
  const key = `${REDIS_KEYS.SYSTEM.NOTIFICATION_COUNTS}:${userId}`;
  const counts = await redis.hGetAll(key);
  if (!Object.keys(counts).length) return undefined;
  return Object.entries(counts).map(([category, count]) => {
    const castedCount = Number(count);
    return {
      category: category as NotificationCategory,
      count: castedCount > 0 ? castedCount : 0,
    };
  }) as NotificationCategoryArray;
}

async function setUser(userId: number, counts: NotificationCategoryArray) {
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
  if (!hasUser(userId)) return;
  logToAxiom({ type: 'decrementUser', userId, category }, 'webhooks').catch();
  await incrementUser(userId, category, -by);
  await slideExpiration(userId);
}

async function bustUser(userId: number) {
  const key = getUserKey(userId);
  await redis.del(key);
}

async function clearCategory(userId: number, category: NotificationCategory) {
  const key = getUserKey(userId);
  if (!hasUser(userId)) return;
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
