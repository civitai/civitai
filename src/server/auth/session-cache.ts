import { redis, REDIS_KEYS } from '~/server/redis/client';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';

export async function clearSessionCache(userId: number) {
  await Promise.all([
    redis.del(`${REDIS_KEYS.USER.SESSION}:${userId}`),
    redis.del(`${REDIS_KEYS.CACHES.MULTIPLIERS_FOR_USER}:${userId}`),
    redis.del(`${REDIS_KEYS.USER.SETTINGS}:${userId}`),
    invalidateCivitaiUser({ userId }),
  ]);
}
