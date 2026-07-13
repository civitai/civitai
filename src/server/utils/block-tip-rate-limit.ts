import { redis, REDIS_KEYS } from '~/server/redis/client';

/**
 * Per-instance fixed-window rate limit for the App Blocks TIP endpoint
 * (`POST /api/v1/blocks/tip`).
 *
 * WHY: tipping moves REAL Buzz out of the viewer's account. The underlying
 * `createBuzzTipTransactionHandler` already enforces balance, self-tip, banned,
 * blocked, and 24h-account gates, but a block that hammered the endpoint (a UI
 * bug or a hostile iframe) could still churn many small tips + notifications.
 * This bounds the per-instance tip RATE without touching the money-authority
 * surface (the handler stays the sole arbiter of whether a tip is allowed).
 *
 * PATTERN: reuses the established blocks fixed-window limiter — the SAME
 * INCR + EXPIRE shape as `checkBlockCatalogRateLimit` /
 * `BlockTokenService.checkRateLimit`, on the `redis` cache client, under a
 * distinct `:tip:` sub-namespace so it never contends with the mint-token or
 * catalog buckets.
 *
 * KEY: `claims.blockInstanceId` — the stable per-instance identity the same
 * in-block iframe reuses. We key on the instance (not `jti`, which rotates on
 * every re-mint) so an abuser can't churn tokens for a fresh bucket.
 *
 * FAIL-CLOSED: unlike the catalog limiter (which fails OPEN so a read surface
 * never breaks on a redis blip), the tip limiter fails CLOSED on a redis error
 * — a money-moving endpoint must not become unbounded when its limiter is down.
 * The caller surfaces this as a retryable 429/503.
 */

// CEILING: a human tipping through a player taps at most a handful of times a
// minute (tip creator / tip curator on the current media). 10 tips / 60s per
// instance is generous for real use and bounds a runaway loop / hostile churn.
export const BLOCK_TIP_RATE_LIMIT_MAX = 10;
export const BLOCK_TIP_RATE_LIMIT_WINDOW_SECONDS = 60;

export type BlockTipRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Records one tip attempt against `blockInstanceId`'s window and reports whether
 * it is within the per-instance ceiling.
 *
 * @param blockInstanceId stable per-instance identity from `req.blockClaims`.
 * @returns `{ allowed: true }` under the limit; `{ allowed: false,
 *   retryAfterSeconds }` once the window's count exceeds the ceiling OR on any
 *   redis error (FAIL-CLOSED — money path).
 */
export async function checkBlockTipRateLimit(
  blockInstanceId: string
): Promise<BlockTipRateLimitResult> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:tip:${blockInstanceId}` as const;
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, BLOCK_TIP_RATE_LIMIT_WINDOW_SECONDS);
    } else {
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, BLOCK_TIP_RATE_LIMIT_WINDOW_SECONDS);
    }

    if (count <= BLOCK_TIP_RATE_LIMIT_MAX) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) {
      retryAfter = BLOCK_TIP_RATE_LIMIT_WINDOW_SECONDS;
    }
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // FAIL-CLOSED — a money-moving endpoint must not run unbounded when the
    // limiter's redis is unreachable. Surface a retryable back-off.
    return { allowed: false, retryAfterSeconds: BLOCK_TIP_RATE_LIMIT_WINDOW_SECONDS };
  }
}
