import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/**
 * Per-APP aggregate generation-SPEND + VELOCITY cap (G8 — generic per-app
 * safety). The HARD PREREQUISITE, called out in-code at
 * `blocks.router.ts` (the spend-attribution "SYBIL CAP NOTE") and in the
 * `app-bounty-cap.service.ts` header, before shareable, spend-driving block
 * apps open to non-moderators.
 *
 * WHY THIS EXISTS — the aggregate-spend leak the per-user cap can't see.
 * The only live spend ceiling today is the per-(USER, UTC-day)
 * `BLOCK_BUZZ_CAP_PER_DAY` (blocks.router.ts). `appBlockId` is intentionally
 * NOT in its key, so a Sybil ring of N sockpuppet accounts each gets its OWN
 * daily spend ceiling, and ALL of that spend can be funnelled through ONE app.
 * The per-user cap cannot see that concentration. And nothing bounds the RATE
 * at which one app fans out generations. This module adds the two missing
 * PER-APP aggregate guardrails, enforced in the submit path BEFORE the spend,
 * on top of the per-user cap:
 *   1. a rolling per-APP DAILY Buzz-spend total, and
 *   2. a short-window per-APP generation VELOCITY (gen count).
 *
 * FULLY GENERIC — there is NO "generator" concept here. Every app block that
 * drives budgeted generation is bounded identically, keyed only on its
 * `appBlockId`.
 *
 * SAME atomic INCRBY-with-TTL reserve/refund pattern as the per-user
 * `reserveBlockBuzzSpend` (blocks.router.ts) and the per-app
 * `reserveAppBountyAccrual` (app-bounty-cap.service.ts): INCRBY is atomic, so
 * concurrent submits across many viewers accumulate correctly with NO
 * read→check→record TOCTOU. The daily key is a full RESERVE-AND-REFUND (a spend
 * is all-or-nothing — you cannot partially run a generation), unlike the bounty
 * cap which CLAMPS an accrual.
 *
 * EXCLUSIONS (matches the existing caps' posture): the caller (submitWorkflow)
 * skips this cap entirely for DEV/live-harness tokens (`claims.dev === true`),
 * which carry a synthetic, non-FK `appBlockId` and already have their own
 * per-session dev-tunnel spend backstop. So only REAL deployed app blocks are
 * bounded here — a dev iterating locally is never clamped by the aggregate cap.
 *
 * FAIL-SAFE: on a Redis error the reserve rolls back any partial increment
 * (best-effort) and DENIES (`allowed: false`), so a Redis blip degrades to
 * "submit rejected, no spend" — the safe direction for an abuse cap, never to
 * "uncapped aggregate spend". (The per-user `reserveBlockBuzzSpend` runs FIRST
 * and fails closed by throwing on any Redis error, so in practice a real Redis
 * outage rejects the submit before this reserve is even reached.)
 */

/**
 * Per-app daily ceiling on block-initiated generation SPEND, in Buzz.
 *
 * Reasoning for the default (relative to the per-user cap):
 *   - The per-user cap is `BLOCK_BUZZ_CAP_PER_DAY = 50_000` Buzz/day ≈ $50/day
 *     of spend per user (yellow Buzz at 1000 Buzz = $1).
 *   - One app serves MANY users, so the per-app aggregate must be a generous
 *     multiple. `5_000_000` Buzz/day ≈ $5,000/day ≈ the aggregate spend of ~100
 *     fully-maxed legitimate users through one app — ample headroom for a
 *     genuinely popular app, while still bounding a Sybil ring (which would
 *     otherwise be UNCAPPED per app) to a fixed daily spend per app.
 *
 * Override at deploy time with `BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY` (an integer
 * count of Buzz) to tighten or loosen without a code change. An unset /
 * unparseable / non-positive value falls back to the default (fail-safe: a sane
 * positive cap is always in force).
 */
export const BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY: number = (() => {
  const fromEnv = Number(process.env.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 5_000_000;
})();

/**
 * Per-app generation VELOCITY ceiling: at most this many block-initiated
 * generations per app per `BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS`. Bounds a
 * burst/DoS where one app fans out many rapid submits (incl. 0-cost / cache-hit
 * gens the Buzz total wouldn't catch). Default 120 gens / 60s ≈ 2 gens/sec
 * sustained per app — well above any real single app's interactive rate.
 *
 * Override with `BLOCK_APP_SPEND_VELOCITY_MAX_GENS`. Non-positive/unparseable →
 * default (fail-safe).
 */
export const BLOCK_APP_SPEND_VELOCITY_MAX_GENS: number = (() => {
  const fromEnv = Number(process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 120;
})();

/**
 * The rolling window (seconds) the velocity ceiling is measured over. Fixed
 * bucket: `floor(now/window)` — the standard fixed-window limiter. Default 60s.
 * Override with `BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS`.
 */
export const BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS: number = (() => {
  const fromEnv = Number(process.env.BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 60;
})();

// 25h TTL on the daily key: comfortably covers a UTC-day window plus clock
// skew; the key is re-derived per day so a stale counter never bleeds into the
// next window. (Same value + rationale as the per-user cap.)
const DAILY_CAP_TTL_SECONDS = 25 * 60 * 60;

function spendCapWindowKey(): string {
  // UTC calendar day, e.g. '2026-07-15'.
  return new Date().toISOString().slice(0, 10);
}

// Both the daily and velocity counters live under the same APP_SPEND_CAP prefix,
// so both match this branded template — assignable to the typed sysRedis key
// param. `AppSpendDailyKey` is the alias the refund path + router hold.
type AppSpendCapKey = `${typeof REDIS_SYS_KEYS.BLOCKS.APP_SPEND_CAP}:${string}`;
export type AppSpendDailyKey = AppSpendCapKey;

function appSpendDailyKey(appBlockId: string): AppSpendDailyKey {
  // PER-APP aggregate: the key is `${appBlockId}:${UTC-day}` — the SPENDER's
  // userId is intentionally NOT in the key, so EVERY viewer's spend through
  // this app shares ONE daily ceiling (the dual of the per-user cap).
  return `${REDIS_SYS_KEYS.BLOCKS.APP_SPEND_CAP}:${appBlockId}:${spendCapWindowKey()}`;
}

function appSpendVelocityKey(appBlockId: string): AppSpendCapKey {
  const bucket = Math.floor(Date.now() / 1000 / BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS);
  return `${REDIS_SYS_KEYS.BLOCKS.APP_SPEND_CAP}:vel:${appBlockId}:${bucket}`;
}

export type ReserveAppSpendResult = {
  /** Whether the submit may proceed. False → reject fail-safe, no spend. */
  allowed: boolean;
  /**
   * Why the reservation was denied (for the user-facing rejection + logs):
   *   - 'daily'       the per-app daily Buzz ceiling would be exceeded
   *   - 'velocity'    the per-app short-window gen ceiling was exceeded
   *   - 'unavailable' a Redis error → fail closed (deny, no spend)
   * Undefined when allowed.
   */
  reason?: 'daily' | 'velocity' | 'unavailable';
  /** Running per-app daily Buzz total AFTER this reservation (for logging). */
  dailyTotal: number;
  /** Running per-app velocity count in the current window (for logging). */
  velocityCount: number;
  /**
   * The EXACT daily key the cost was reserved against — pass to
   * `refundAppSpend` if the submit later throws. Present iff a daily
   * reservation was actually made (cost > 0 and allowed).
   */
  dailyKey?: AppSpendDailyKey;
};

/**
 * Atomically reserve one block-initiated generation against this APP's
 * aggregate ceilings and return whether the submit may proceed.
 *
 * Order: DAILY Buzz reserve first (a spend is all-or-nothing), then VELOCITY.
 *   - Daily: INCRBY `cost` on the per-app UTC-day counter. If it pushes the
 *     total over the cap, REFUND the full cost (best-effort DECRBY on the
 *     pinned key) and deny — the whole submit is rejected, so we never leave a
 *     partial reservation. A `cost <= 0` gen (cache-hit / 0-cost) adds nothing
 *     to the daily total but STILL counts toward velocity below.
 *   - Velocity: INCR the current fixed-window bucket by 1. If it exceeds the
 *     max, REFUND the daily reservation and deny. The velocity counter itself
 *     is NOT refunded on a velocity-deny — a denied ATTEMPT still consumed a
 *     rate slot (standard fixed-window limiter), and the bucket self-expires.
 *
 * On a Redis error anywhere, best-effort roll back any partial daily
 * reservation and deny (`reason: 'unavailable'`) — fail-safe, no spend.
 */
export async function reserveAppSpend(
  appBlockId: string,
  cost: number
): Promise<ReserveAppSpendResult> {
  const want = Math.max(0, Math.ceil(cost));
  const dailyKey = appSpendDailyKey(appBlockId);

  let dailyReserved = 0;
  let dailyTotal = 0;
  try {
    // 1) DAILY Buzz reserve (skip the Redis round-trip for a 0-cost gen; it
    //    would only INCRBY 0 and needlessly arm a TTL on an empty key).
    if (want > 0) {
      dailyTotal = await sysRedis.incrBy(dailyKey, want);
      dailyReserved = want;
      if (dailyTotal <= want) {
        await sysRedis.expire(dailyKey, DAILY_CAP_TTL_SECONDS);
      } else {
        const ttl = await sysRedis.ttl(dailyKey);
        if (ttl < 0) await sysRedis.expire(dailyKey, DAILY_CAP_TTL_SECONDS);
      }
      if (dailyTotal > BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY) {
        // Over the daily cap → refund the full cost (all-or-nothing) and deny.
        await refundAppSpend(dailyKey, want);
        return { allowed: false, reason: 'daily', dailyTotal, velocityCount: 0 };
      }
    }

    // 2) VELOCITY reserve (always — 0-cost gens still count as gens).
    const velocityKey = appSpendVelocityKey(appBlockId);
    const velocityCount = await sysRedis.incrBy(velocityKey, 1);
    if (velocityCount <= 1) {
      await sysRedis.expire(velocityKey, BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS);
    } else {
      const ttl = await sysRedis.ttl(velocityKey);
      if (ttl < 0) await sysRedis.expire(velocityKey, BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS);
    }
    if (velocityCount > BLOCK_APP_SPEND_VELOCITY_MAX_GENS) {
      // Over the velocity ceiling → refund the daily reservation and deny. The
      // velocity counter itself is left incremented (a rejected attempt still
      // consumed a rate slot; the bucket self-expires).
      if (dailyReserved > 0) await refundAppSpend(dailyKey, dailyReserved);
      return { allowed: false, reason: 'velocity', dailyTotal, velocityCount };
    }

    return {
      allowed: true,
      dailyTotal,
      velocityCount,
      ...(dailyReserved > 0 ? { dailyKey } : {}),
    };
  } catch {
    // Redis error → fail closed. Best-effort roll back any daily reservation we
    // managed to make so the counter doesn't over-count a denied submit, then
    // deny with no spend.
    if (dailyReserved > 0) await refundAppSpend(dailyKey, dailyReserved);
    return { allowed: false, reason: 'unavailable', dailyTotal, velocityCount: 0 };
  }
}

/**
 * Refund `cost` previously reserved against the EXACT daily key returned by
 * `reserveAppSpend` (best-effort DECRBY). Used when the submit throws AFTER a
 * successful reservation but before a resolved orchestrator submit. Never
 * throws into the caller.
 *
 * Takes the reserved key rather than re-deriving it from appBlockId: the key
 * embeds the UTC-day window, and the throw-path refund runs AFTER the
 * (multi-second) orchestrator submit, so re-deriving could land on the NEXT
 * day's key if the request straddled midnight UTC — handing the app extra
 * headroom. Pinning the key eliminates that race (same reasoning as the
 * per-user `refundBlockBuzzSpend`). A lost refund over-counts, which only makes
 * the cap STRICTER — the safe direction for an abuse cap.
 */
export async function refundAppSpend(key: AppSpendDailyKey, cost: number): Promise<void> {
  const amount = Math.ceil(cost);
  if (amount <= 0) return;
  await sysRedis.decrBy(key, amount).catch(() => {
    /* best-effort — a lost refund over-counts (stricter cap), never looser */
  });
}
