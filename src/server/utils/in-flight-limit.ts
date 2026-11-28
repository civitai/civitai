import { TRPCError } from '@trpc/server';
import { REDIS_KEYS } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { acquireConcurrencySlot, type ConcurrencySlot } from '~/server/utils/concurrency-slots';
import { throwRateLimited } from '~/server/utils/rate-limit-error';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import type { RateLimitMeta } from '~/shared/utils/rate-limit-meta';

export type InFlightLimit = {
  /** Procedures given the same bucket share one per-user limit. */
  bucket: string;
  limit: number;
  /** A request still running after this stops counting against the limit. */
  ttlMs: number;
  /** A store slower than this is treated as failed, so a stalled Redis cannot stall the request. */
  acquireTimeoutMs: number;
  errorMessage: string;
  /**
   * The `rateLimit` meta a full pool's refusal carries (`throwRateLimited`). The App Platform's
   * callers pass it (`app-platform-rate-limit-meta.test.ts`); without it the refusal is a bare
   * TOO_MANY_REQUESTS.
   */
  refusalMeta?: () => RateLimitMeta;
};

const ACQUIRE_TIMED_OUT: ConcurrencySlot = { acquired: false, reason: 'unavailable' };

/**
 * Runs `run` holding one of `userId`'s `limit` concurrent slots in `bucket`; refuses with
 * TOO_MANY_REQUESTS (`errorMessage`) when they are all held. Admits when the store fails or takes
 * longer than `acquireTimeoutMs`. The body of the `inFlightLimit` tRPC middleware, here so a
 * procedure can apply it to a user id it resolved itself (a block token's subject).
 */
export async function withInFlightLimit<T>(
  {
    bucket,
    limit,
    ttlMs,
    acquireTimeoutMs,
    errorMessage,
    refusalMeta,
    userId,
  }: InFlightLimit & { userId: number },
  run: () => Promise<T>,
  /**
   * Called once, just before a FULL pool refuses with TOO_MANY_REQUESTS (never on the fail-open
   * path). For the caller's refusal counter; it must not throw, and a throw is swallowed.
   */
  onFull?: () => void
): Promise<T> {
  const key = `${REDIS_KEYS.TRPC.IN_FLIGHT}:${bucket}:${userId}`;
  const acquiring = acquireConcurrencySlot(key, limit, ttlMs);
  const slot = await withTimeoutFallback(acquiring, acquireTimeoutMs, ACQUIRE_TIMED_OUT, () => {
    // A slot granted after we stopped waiting would otherwise count until its TTL.
    void acquiring.then((late) => (late.acquired ? late.release() : undefined));
  });
  if (!slot.acquired) {
    if (slot.reason === 'full') {
      try {
        onFull?.();
      } catch {
        /* instrument-only — never change the refusal */
      }
      if (refusalMeta) throwRateLimited(refusalMeta(), errorMessage);
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: errorMessage });
    }
    logSysRedisFailOpen('read-degraded', 'middleware.trpc.inFlightLimit', slot.error, {
      bucket,
      userId,
    });
    return await run();
  }

  try {
    return await run();
  } finally {
    // Not awaited: the work is done, and a stalled store must not hold the response.
    void slot.release();
  }
}
