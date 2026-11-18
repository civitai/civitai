import { REDIS_KEYS, type RedisKeyTemplateCache } from './client';

/** How long a bust keeps the event engine from caching a fresh read (its `createCache` default). */
export const EVENT_ENGINE_CACHE_DEBOUNCE_SECONDS = 10;

type HashClient = {
  hSet(key: RedisKeyTemplateCache, value: Record<string, string>): Promise<unknown>;
  expire(key: RedisKeyTemplateCache, seconds: number): Promise<unknown>;
};

/**
 * Busts users' entries in the event engine's profile-picture cache the way its own `bust` does
 * (apps/event-engine/src/common/caches/base.ts): a debounce marker that reads as a miss and, for a
 * few seconds, keeps a lagging replica read from caching the old picture again.
 */
export async function bustEventEngineProfilePictures(client: HashClient, userIds: number[]) {
  const cachedAt = new Date().toISOString();
  await Promise.all(
    [...new Set(userIds)].map(async (id) => {
      const key: RedisKeyTemplateCache = `${REDIS_KEYS.CACHES.EVENT_ENGINE_PROFILE_PICTURES}:${id}`;
      await client.hSet(key, { debounce: '1', cachedAt });
      await client.expire(key, EVENT_ENGINE_CACHE_DEBOUNCE_SECONDS);
    })
  );
}
