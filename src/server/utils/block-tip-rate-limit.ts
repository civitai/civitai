import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

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

// ── Tip amount caps (what makes block tipping PAGE-SAFE) ──────────────────────
// Tipping is money OUT to third parties and is NOT gated by the per-gen
// `buzzBudget` cost-preflight, so a page tip needs its OWN explicit bounds — the
// analogue of the gen-spend `buzzBudget` + `BLOCK_BUZZ_CAP_PER_DAY` pair. These
// two caps are the load-bearing safety that let `social:tip:self` come off
// PAGE_FORBIDDEN_SCOPES: a compromised/buggy block can neither drain an account
// in one call (per-tip cap) nor bleed it over a day (per-user daily cap).

// Per-single-tip ceiling. Bounds one call; a block can't move a large sum in one
// shot. Conservative vs. the gen per-call budget cap (1000) — a tip is a direct
// transfer to another user, but a legitimate creator tip can reasonably exceed
// 1000, so this is set higher while still hard-bounding a single request.
export const BLOCK_TIP_MAX_PER_TIP = 5_000;
// Per-USER daily aggregate across ALL of a user's installed blocks (the key omits
// appBlockId, mirroring BLOCK_BUZZ_CAP_PER_DAY, so a publisher can't multiply the
// ceiling by spinning up N blocks). Set BELOW the gen daily cap (50_000) because
// tips are irreversible transfers to third parties.
export const BLOCK_TIP_CAP_PER_DAY = 25_000;
// 25h TTL: covers a UTC-day window plus skew; the key is re-derived per day so a
// stale counter never bleeds into the next window.
const BLOCK_TIP_CAP_TTL_SECONDS = 25 * 60 * 60;

function tipCapWindowKey(): string {
  return new Date().toISOString().slice(0, 10); // UTC calendar day
}

function tipCapRedisKey(userId: number): `${typeof REDIS_SYS_KEYS.BLOCKS.TIP_CAP}:${string}` {
  // PER-USER aggregate: appBlockId is intentionally NOT part of the key.
  return `${REDIS_SYS_KEYS.BLOCKS.TIP_CAP}:${userId}:${tipCapWindowKey()}`;
}

/**
 * Atomically reserves `amount` against this user's cumulative UTC-day tip counter
 * and returns the new running total + the exact key reserved. INCRBY is atomic so
 * concurrent tips accumulate correctly with no read→check→record TOCTOU. Sets the
 * TTL on the (effectively) first write. No try/catch: a Redis error throws and
 * fails the tip CLOSED (mirrors reserveBlockBuzzSpend). Caller compares `total`
 * against BLOCK_TIP_CAP_PER_DAY and refunds via the returned key on over-cap /
 * on any downstream failure.
 */
export async function reserveBlockTipSpend(
  userId: number,
  amount: number
): Promise<{ total: number; key: ReturnType<typeof tipCapRedisKey> }> {
  const key = tipCapRedisKey(userId);
  const total = await sysRedis.incrBy(key, Math.ceil(amount));
  if (total <= Math.ceil(amount)) {
    await sysRedis.expire(key, BLOCK_TIP_CAP_TTL_SECONDS);
  } else {
    const ttl = await sysRedis.ttl(key);
    if (ttl < 0) await sysRedis.expire(key, BLOCK_TIP_CAP_TTL_SECONDS);
  }
  return { total, key };
}

/**
 * Refunds a previously-reserved tip `amount` (best-effort DECRBY) against the
 * EXACT key returned by reserveBlockTipSpend. Used when the reservation pushed the
 * total over the daily cap, or when the tip transaction throws (insufficient
 * funds, etc.). Best-effort: a failed refund leaves the reservation in place →
 * OVER-counts → the cap is only made STRICTER (the safe direction). Never throws.
 * Takes the reserved key (not re-derived) so a request straddling midnight UTC
 * refunds the day it reserved, not the next day's key.
 */
export async function refundBlockTipSpend(
  key: ReturnType<typeof tipCapRedisKey>,
  amount: number
): Promise<void> {
  await sysRedis.decrBy(key, Math.ceil(amount)).catch(() => {
    /* best-effort — a lost refund over-counts (stricter cap) */
  });
}
