import { randomUUID } from 'crypto';
import { redis } from '~/server/redis/client';

export type ConcurrencySlot =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; reason: 'full' | 'unavailable'; error?: unknown };

/**
 * Take one of `limit` concurrent slots under `key`. A slot counts for at most `ttlMs`, so a request
 * still running past that, or whose process died, stops counting.
 *
 * A sorted set whose scores are each slot's own expiry, not a counter: a counter's leaked increment
 * from a dead process lives until the whole key goes idle, which a busy key never does, while an
 * expired entry is dropped on the next acquire. The steps are not atomic; two racing acquirers at
 * the limit can both see the other and both be refused, so a race over-refuses but never admits
 * more than `limit` (TTL expiry aside).
 *
 * `unavailable` means the store failed and no slot is held; what that means is the caller's call.
 */
export async function acquireConcurrencySlot(
  key: string,
  limit: number,
  ttlMs: number
): Promise<ConcurrencySlot> {
  const member = randomUUID();
  const release = async () => {
    try {
      await redis.zRem(key as never, member);
    } catch {
      // the entry expires on its own
    }
  };
  try {
    const now = Date.now();
    await redis.zRemRangeByScore(key as never, '-inf', now);
    await redis.zAdd(key as never, { score: now + ttlMs, value: member });
    await redis.expire(key as never, Math.ceil(ttlMs / 1000));
    const held = await redis.zCard(key as never);
    if (typeof held === 'number' && Number.isFinite(held)) {
      if (held <= limit) return { acquired: true, release };
      await release();
      return { acquired: false, reason: 'full' };
    }
    await release();
    return { acquired: false, reason: 'unavailable' };
  } catch (error) {
    await release();
    return { acquired: false, reason: 'unavailable', error };
  }
}
