import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/**
 * Per-APP spend-BOUNTY accrual cap (App-Blocks Sybil-economics review,
 * audit note 🟡-2 at `blocks.router.ts:~2379`).
 *
 * WHY THIS EXISTS — the residual Sybil leak.
 * The block buzz-SPEND flow (W3 flow A, #2627) accrues a PLATFORM-FUNDED
 * author bounty (`spendSharePct` of the spend's USD value, paid ON TOP of the
 * spend — net-new platform money, NOT a cut of the viewer's Buzz). The only
 * live cap today is `BLOCK_BUZZ_CAP_PER_DAY` (blocks.router.ts), which is
 * per-(USER, UTC-day) — `appBlockId` is intentionally NOT in its key. So a
 * Sybil ring of N sockpuppet accounts each gets its OWN 50k/day spend ceiling,
 * and ALL of that spend can be funnelled through ONE app to mint UNBOUNDED
 * platform-funded bounty toward ONE author. The per-user cap cannot see that
 * concentration. This module adds the missing PER-APP aggregate ceiling.
 *
 * It is the SAME atomic INCRBY-with-TTL pattern as the per-user cap
 * (`reserveBlockBuzzSpend`), just keyed on `appBlockId` and denominated in the
 * accrued BOUNTY (USD cents), not the raw user spend (Buzz). Reserving the
 * bounty (not the spend) is what makes it DORMANT by construction today (see
 * below).
 *
 * DORMANT TODAY — true by construction, not by configuration.
 * The amount reserved here is the row's accrued `app_owner_share_cents`. The
 * spend flow is TRACK-ONLY until the payout rail (#2605) flips
 * `spendSharePct > 0` for non-mods, so EVERY spend-attribution row is written
 * with `app_owner_share_cents = 0`. Reserving 0 never advances the per-app
 * counter, so the cap NEVER clamps and live behaviour is byte-identical to
 * before this change. When #2605 starts stamping a non-zero accrued share at
 * write time, this cap is already enforcing — it pre-lands the guardrail.
 *
 * ⚠️ CAP VALUE NEEDS LEADERSHIP SIGN-OFF before #2605 flips `spendSharePct > 0`
 * for non-mods. `BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY` below is a documented
 * PLACEHOLDER, not an authoritative number — see its comment.
 */

/**
 * Per-app daily ceiling on accrued spend bounty, in USD CENTS.
 *
 * ⚠️ PLACEHOLDER — NEEDS LEADERSHIP SIGN-OFF before the payout rail (#2605)
 * flips `spendSharePct > 0` for non-moderators. Do not treat this number as
 * authoritative; it only exists so the guardrail is wired and enforcing the
 * moment the rate goes non-zero.
 *
 * Reasoning for the starting point (relative to the per-user cap):
 *   - The per-user cap is `BLOCK_BUZZ_CAP_PER_DAY = 50_000` Buzz/day ≈ $50/day
 *     of spend per user (yellow Buzz at 1000 Buzz = $1).
 *   - At the placeholder `spendSharePct = 5%`, one fully-maxed user mints at
 *     most `5% × $50 = $2.50/day` ≈ 250 cents/day of bounty toward an app.
 *   - One app serves MANY users, so the per-app ceiling must be a multiple of
 *     the per-user-derived bounty. 25_000 cents = $250/day ≈ the bounty from
 *     ~100 fully-maxed legitimate users — generous headroom for a genuinely
 *     popular app, while still bounding a Sybil ring (which would otherwise be
 *     uncapped per app) to a fixed daily platform expense per app.
 *
 * Override at deploy time with `BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY` (an
 * integer count of cents) — e.g. to tighten or loosen after sign-off without a
 * code change. An unset / unparseable / non-positive value falls back to the
 * placeholder default (fail-safe: a sane positive cap is always in force).
 */
export const BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY: number = (() => {
  const fromEnv = Number(process.env.BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 25_000;
})();

// 25h TTL: comfortably covers a UTC-day window plus clock skew; the key is
// re-derived per day so a stale counter never bleeds into the next window.
// (Same value + rationale as the per-user cap's BLOCK_BUZZ_CAP_TTL_SECONDS.)
const BOUNTY_CAP_TTL_SECONDS = 25 * 60 * 60;

function bountyCapWindowKey(): string {
  // UTC calendar day, e.g. '2026-06-24'.
  return new Date().toISOString().slice(0, 10);
}

type BountyCapKey = `${typeof REDIS_SYS_KEYS.BLOCKS.BOUNTY_CAP}:${string}`;

function bountyCapRedisKey(appBlockId: string): BountyCapKey {
  // PER-APP aggregate: the key is `${appBlockId}:${UTC-day}` — the SPENDER's
  // userId is intentionally NOT part of the key, so EVERY viewer's spend
  // through this app shares ONE daily bounty ceiling. This is the dual of the
  // per-user cap (which keys on userId, not appBlockId) and is what bounds a
  // Sybil ring of many accounts pointed at one app.
  return `${REDIS_SYS_KEYS.BLOCKS.BOUNTY_CAP}:${appBlockId}:${bountyCapWindowKey()}`;
}

export type ReserveAppBountyResult = {
  /**
   * The bounty (in cents) that may actually be accrued for this row AFTER the
   * per-app daily cap. Equal to `shareCents` when there is headroom; CLAMPED
   * down to the remaining headroom (possibly 0) when the cap is hit. Always
   * `0 <= grantedCents <= shareCents`.
   */
  grantedCents: number;
  /** True when the cap clamped the accrued bounty below the requested share. */
  clamped: boolean;
  /** The running per-app daily total AFTER this reservation (for logging). */
  total: number;
  /** The exact key reserved against — pass back to a refund if needed. */
  key: BountyCapKey;
};

/**
 * Atomically reserve `shareCents` of bounty against this APP's cumulative
 * UTC-day bounty counter and return how much may actually accrue.
 *
 * Atomicity / TOCTOU-safety: INCRBY is atomic, so concurrent spend
 * attributions across many viewers accumulate correctly with NO
 * read→check→record race (mirrors the per-user `reserveBlockBuzzSpend`). The
 * TTL is armed on the (effectively) first write so the per-window key
 * self-expires; the `ttl < 0` guard re-arms a key that somehow lost its TTL.
 *
 * If the reservation pushes the app's daily total over the cap, the OVERSHOOT
 * is REFUNDED (best-effort DECRBY against the pinned key) and `grantedCents` is
 * the remaining headroom (clamped to ≥ 0). This way the counter converges to
 * exactly the cap and the caller can write a row whose accrued share never
 * pushes the app past its daily ceiling — even under a flood of concurrent
 * sockpuppet spends.
 *
 * `shareCents <= 0` (the DORMANT case today, and self/internal void rows) is a
 * fast no-op: it does NOT touch Redis and grants 0, so the cap path adds zero
 * behaviour and zero Redis load while the bounty is 0.
 *
 * Fail-safe posture: a Redis error here would throw. Callers in the
 * fire-and-forget attribution path already wrap the whole write in try/catch
 * (a failed attribution never breaks the generation), so a Redis blip
 * degrades to "row not written" rather than to "uncapped accrual" — the safe
 * direction for an abuse cap.
 */
export async function reserveAppBountyAccrual(
  appBlockId: string,
  shareCents: number
): Promise<ReserveAppBountyResult> {
  const want = Math.floor(shareCents);
  const key = bountyCapRedisKey(appBlockId);

  // DORMANT fast-path: nothing to accrue (today's track-only 0, or a void
  // self/internal row) → never touch the counter. This is what keeps the cap a
  // pure no-op while `spendSharePct = 0`.
  if (want <= 0) {
    return { grantedCents: 0, clamped: false, total: 0, key };
  }

  const total = await sysRedis.incrBy(key, want);
  if (total <= want) {
    // (effectively) first write this window → arm the TTL.
    await sysRedis.expire(key, BOUNTY_CAP_TTL_SECONDS);
  } else {
    const ttl = await sysRedis.ttl(key);
    if (ttl < 0) await sysRedis.expire(key, BOUNTY_CAP_TTL_SECONDS);
  }

  if (total <= BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY) {
    // Full headroom — accrue the whole share.
    return { grantedCents: want, clamped: false, total, key };
  }

  // Over the cap. Refund the OVERSHOOT so the counter converges to exactly the
  // cap (concurrent reservations across viewers all see the true running total
  // because INCRBY is atomic). Grant only the remaining headroom, clamped ≥ 0.
  const overshoot = total - BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY;
  const grantedCents = Math.max(0, want - overshoot);
  // Refund the portion we will NOT accrue. Best-effort: a lost refund leaves
  // the counter higher, which only makes the cap STRICTER (the safe direction
  // for an abuse cap), never looser.
  await refundAppBountyAccrual(key, want - grantedCents);

  return { grantedCents, clamped: true, total, key };
}

/**
 * Refund `cents` previously reserved against the EXACT key returned by
 * `reserveAppBountyAccrual` (best-effort DECRBY). Used to release the overshoot
 * when the cap clamps, or to undo a full reservation if the caller decides not
 * to write the row after reserving. Never throws into the caller.
 *
 * Takes the reserved key rather than re-deriving it from appBlockId: the key
 * embeds the UTC-day window, so re-deriving across a midnight-UTC boundary
 * could decrement the NEXT day's key (handing the app extra headroom). Pinning
 * the key eliminates that race — the same reasoning as the per-user
 * `refundBlockBuzzSpend`.
 */
export async function refundAppBountyAccrual(key: BountyCapKey, cents: number): Promise<void> {
  const amount = Math.floor(cents);
  if (amount <= 0) return;
  await sysRedis.decrBy(key, amount).catch(() => {
    /* best-effort — a lost refund over-counts (stricter cap), never looser */
  });
}
