/** The three commands a fixed window needs, so either app's cache client (or a test double) fits. */
export type FixedWindowCounter = {
  incrBy(key: never, by: number): Promise<number>;
  expire(key: never, seconds: number): Promise<unknown>;
  ttl(key: never): Promise<number>;
};

export type FixedWindowResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Counts one hit on `key` in a fixed window of `windowSeconds` and reports whether it is within
 * `max`. A Redis error admits, unless `failOpen` is false.
 */
export async function checkFixedWindowWith(
  redis: FixedWindowCounter,
  key: string,
  max: number,
  windowSeconds: number,
  { failOpen = true }: { failOpen?: boolean } = {}
): Promise<FixedWindowResult> {
  try {
    const count = await redis.incrBy(key as never, 1);
    // Re-asserts a lost TTL: a crash between INCR and EXPIRE would otherwise lock the key for good.
    if (count === 1 || (await redis.ttl(key as never)) < 0)
      await redis.expire(key as never, windowSeconds);
    if (count <= max) return { allowed: true };
    const ttl = await redis.ttl(key as never);
    return {
      allowed: false,
      retryAfterSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : windowSeconds,
    };
  } catch {
    return failOpen ? { allowed: true } : { allowed: false, retryAfterSeconds: windowSeconds };
  }
}
