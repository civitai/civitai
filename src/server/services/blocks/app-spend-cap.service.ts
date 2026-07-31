import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS,
  STRICTEST_APP_CAP_LIMITS,
  type AppCapLimits,
} from '~/server/services/blocks/app-cap-limits.constants';
import { resolveAppCapLimits } from '~/server/services/blocks/app-cap-limits.service';

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
 * ✅ PER-APP LIMITS (the non-mod-GA prerequisite this header used to flag).
 * The ceilings are no longer ONE global value applied to every app. They are
 * resolved PER APP by `resolveAppCapLimits` (`app-cap-limits.service.ts`) from
 * the app's server-owned `trustTier`, with a moderator-set per-app override on
 * top; `app-cap-limits.constants.ts` holds the tier→limits table, the
 * (still env-overridable) global bases those tiers derive from, and the
 * fail-closed fallback rules.
 *
 * The two things that changed for enforcement, both LOCAL to this file:
 *   1. `reserveAppSpend` resolves `{ dailyBuzz, velocityMaxGens }` for the app
 *      before reserving, instead of reading two module constants.
 *   2. A resolve failure is inside the SAME try/catch as the Redis work, so it
 *      denies fail-safe exactly like a Redis error would — and the resolver
 *      itself independently degrades to the strictest tier rather than throwing.
 *
 * Everything else — the key shapes, the atomic INCRBY reserve/refund, the
 * all-or-nothing daily semantics, the pinned-key refund contract — is unchanged.
 * 🔴 `AppSpendDailyKey`'s shape in particular is load-bearing: the throw-path
 * refunds in `blocks.router.ts` and the PERSISTED `appSpendKey` on customComfy
 * settle records (`custom-comfy-settle.service.ts`) both hold keys minted here,
 * including keys written by an earlier deploy.
 */

/**
 * Re-exported for callers/tests that consumed these from this module before the
 * limits moved out. They are now the GLOBAL BASES the tier table derives from —
 * `BLOCK_APP_SPEND_VELOCITY_MAX_GENS` is the `verified`-tier ceiling (raised
 * 120 → 600), NOT the ceiling every app gets. The effective per-app value is
 * whatever `resolveAppCapLimits` returns.
 */
export {
  BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY,
  BLOCK_APP_SPEND_VELOCITY_MAX_GENS,
  BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS,
} from '~/server/services/blocks/app-cap-limits.constants';

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
  /**
   * The ceilings this reservation was actually judged against (per-app, from
   * `resolveAppCapLimits`). Exposed for logging/telemetry so a rejection can be
   * attributed to the app's ACTUAL tier/override rather than guessed from a
   * global constant. 🔴 NOT surfaced to the app itself — `blocks.router.ts`
   * deliberately returns a no-number rejection so a hostile app can't probe its
   * exact ceiling. On a fail-closed path this is the strictest-tier pair.
   */
  limits: AppCapLimits;
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
 * The ceilings are PER-APP: `resolveAppCapLimits` maps the app's server-owned
 * `trustTier` (plus any moderator override) to `{ dailyBuzz, velocityMaxGens }`.
 * It is resolved INSIDE the try/catch below, so a resolution failure denies
 * fail-safe exactly like a Redis error — and the resolver itself independently
 * degrades to the STRICTEST tier rather than to "uncapped", so there is no
 * ordering in which a lookup problem widens a ceiling.
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
  // Pre-seeded with the strictest ceilings so EVERY exit path (including a throw
  // before resolution completes) reports a real, bounded pair — never a
  // partially-initialised or absent one.
  let limits: AppCapLimits = STRICTEST_APP_CAP_LIMITS;
  try {
    // 0) Resolve THIS app's ceilings. Cheap: an in-process TTL cache hit on the
    //    hot path, one PK lookup per app per TTL window on a miss.
    limits = await resolveAppCapLimits(appBlockId);

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
      if (dailyTotal > limits.dailyBuzz) {
        // Over the daily cap → refund the full cost (all-or-nothing) and deny.
        await refundAppSpend(dailyKey, want);
        return { allowed: false, reason: 'daily', dailyTotal, velocityCount: 0, limits };
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
    if (velocityCount > limits.velocityMaxGens) {
      // Over the velocity ceiling → refund the daily reservation and deny. The
      // velocity counter itself is left incremented (a rejected attempt still
      // consumed a rate slot; the bucket self-expires).
      if (dailyReserved > 0) await refundAppSpend(dailyKey, dailyReserved);
      return { allowed: false, reason: 'velocity', dailyTotal, velocityCount, limits };
    }

    return {
      allowed: true,
      dailyTotal,
      velocityCount,
      limits,
      ...(dailyReserved > 0 ? { dailyKey } : {}),
    };
  } catch {
    // Redis error (or a limit-resolution throw) → fail closed. Best-effort roll
    // back any daily reservation we managed to make so the counter doesn't
    // over-count a denied submit, then deny with no spend.
    if (dailyReserved > 0) await refundAppSpend(dailyKey, dailyReserved);
    return { allowed: false, reason: 'unavailable', dailyTotal, velocityCount: 0, limits };
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
