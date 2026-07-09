import { redis, REDIS_KEYS } from '~/server/redis/client';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';
import { sessionClient } from '~/server/auth/session-client';

export async function clearSessionCache(userId: number) {
  await Promise.all([
    // session:data2 is hub-owned — ask the hub to bust it (so it re-produces on next read). Fall back to a
    // direct del on a hub blip: busting a key the hub re-produces is safe from either side.
    sessionClient.invalidate(userId).catch(() => redis.del(`${REDIS_KEYS.USER.SESSION}:${userId}`)),
    // main-app-only per-user caches (not hub-owned) — cleared directly.
    redis.del(`${REDIS_KEYS.CACHES.MULTIPLIERS_FOR_USER}:${userId}`),
    redis.del(`${REDIS_KEYS.USER.SETTINGS}:${userId}`),
    // orchestrator's cached civitai user — a main-app concern, fired here at the invalidation point.
    invalidateCivitaiUser({ userId }),
  ]);
}
