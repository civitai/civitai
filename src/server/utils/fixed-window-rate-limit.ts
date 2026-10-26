import { redis } from '~/server/redis/client';

export type FixedWindowResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

// `never` keys so both `redis` and `sysRedis` (different typed key unions) fit.
type CounterClient = {
  incrBy(key: never, by: number): Promise<number>;
  expire(key: never, seconds: number): Promise<unknown>;
  ttl(key: never): Promise<number>;
};

/**
 * Count one hit on `key` against `max` per `windowSeconds`. `failOpen` decides a Redis error: open
 * for defence in depth, closed where the limit is the only bound on spend.
 */
export async function checkFixedWindow(
  key: string,
  max: number,
  windowSeconds: number,
  { failOpen, client = redis }: { failOpen: boolean; client?: CounterClient }
): Promise<FixedWindowResult> {
  try {
    const count = await client.incrBy(key as never, 1);
    if (count === 1) {
      await client.expire(key as never, windowSeconds);
    } else {
      // Re-assert a lost TTL (crash between INCR and EXPIRE would otherwise strand
      // a TTL-less key → permanent lock). Same mitigation as the mint limiter.
      const ttl = await client.ttl(key as never);
      if (ttl < 0) await client.expire(key as never, windowSeconds);
    }

    if (count <= max) return { allowed: true };

    let retryAfter = await client.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) retryAfter = windowSeconds;
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    return failOpen ? { allowed: true } : { allowed: false, retryAfterSeconds: windowSeconds };
  }
}
