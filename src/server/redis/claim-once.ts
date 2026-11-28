import { redis, type RedisKeyTemplateCache } from '~/server/redis/client';

/**
 * Set `key` once, for `ttlSeconds`. True on the first claim; false when it is already held (a
 * replay). Throws when Redis cannot answer: the caller refuses. On the cache cluster: an eviction
 * reopens the window for that one key until its TTL would have run out.
 */
export async function claimOnce(key: RedisKeyTemplateCache, ttlSeconds: number): Promise<boolean> {
  return (await redis.set(key, '1', { NX: true, EX: ttlSeconds })) !== null;
}
