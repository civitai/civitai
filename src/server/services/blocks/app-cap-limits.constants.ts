/**
 * PER-APP generation-cap LIMITS — the pure (no-IO) half of the per-app spend /
 * velocity guardrail. The stateful half (the DB read + its cache) lives in
 * `app-cap-limits.service.ts`; the enforcement lives in
 * `app-spend-cap.service.ts`.
 *
 * WHY THIS EXISTS — the non-mod-GA prerequisite the cap module called out.
 * The G8 per-app cap shipped with ONE global ceiling applied to EVERY app
 * (env-overridable, but not PER-app). Its own header flagged that as the
 * blocker for opening App Blocks to non-moderators: a modestly popular app
 * would brush the 120-gens/60s velocity ceiling (~2 gens/sec AGGREGATE across
 * ALL its viewers) and its users would start seeing abuse rejections. That
 * converts platform SUCCESS into user-visible FAILURE — the opposite of what an
 * anti-Sybil guardrail is for.
 *
 * WHAT REPLACES IT — limits derived from the app's `trustTier`, with an
 * admin-set per-app override on top:
 *
 *     effective limits = override (per field, when set)
 *                        ELSE the app's trustTier's limits
 *                        ELSE the STRICTEST tier's limits   ← fail-closed
 *
 * 🔴 The tier is the PLATFORM's assessment, never the developer's claim.
 * `AppBlock.trustTier` is server-owned: the manifest schema declares it only to
 * REJECT a dev-supplied value, `blocks.updateManifest` forces the stored tier
 * back over any client patch, and `/api/v1/developer/block-manifests` refuses a
 * tier change outright. The manifest is therefore NOT a valid source for a cap
 * — a developer must never be able to raise their own abuse ceiling. Same for
 * the override columns: mod-only write path (`BlockRegistry.setAppSpendCapOverride`,
 * behind `moderatorProcedure`).
 *
 * 🔴 FAIL-CLOSED IN EVERY DIRECTION. There is no code path here that widens a
 * limit on missing/garbage input. An unknown tier string, a NULL tier, a
 * missing app row, an absent override and an out-of-range override all resolve
 * to a REAL positive ceiling — `STRICTEST_APP_CAP_LIMITS`, computed as the
 * per-field minimum over the whole tier table, so it stays correct even if the
 * table below is later re-ordered or re-tuned. "Uncapped" is unrepresentable:
 * every value in this module is a positive integer.
 */

/**
 * The REAL `AppBlock.trustTier` values. Authoritative source: the canonical
 * manifest schema `public/schemas/app-block/v1.json` (`trustTier.enum`) and the
 * `app_blocks.trust_tier` column (a String defaulting to `'unverified'`).
 *
 * 🔴 The column is a free-text String, NOT a DB enum — so a row CAN carry a
 * value outside this list (a hand-written UPDATE, a future tier added to the
 * schema but not here). That is exactly why `limitsForTier` treats anything
 * unrecognised as the strictest tier instead of assuming membership.
 */
export const APP_TRUST_TIERS = ['unverified', 'verified', 'internal'] as const;
export type AppTrustTier = (typeof APP_TRUST_TIERS)[number];

/** The pair of per-app ceilings the reserve path enforces. Both are positive integers. */
export type AppCapLimits = {
  /** Per-app per-UTC-day aggregate generation SPEND ceiling, in Buzz. */
  dailyBuzz: number;
  /**
   * Per-app generation-count ceiling per
   * `BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS` (burst control; also catches the
   * 0-cost / cache-hit gens the Buzz counter can't see).
   */
  velocityMaxGens: number;
};

/**
 * Parse a positive-integer env override, fail-safe. Unset / unparseable /
 * non-finite / zero / negative → the built-in default, so a sane positive
 * ceiling is ALWAYS in force and a typo in a deploy env can never disable a cap.
 * (Identical semantics to the original inline parsers — preserved verbatim so
 * `BLOCK_APP_SPEND_*` env vars keep working exactly as documented.)
 */
function envPositiveInt(name: string, fallback: number): number {
  const fromEnv = Number(process.env[name]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : fallback;
}

/**
 * GLOBAL daily Buzz ceiling — the base the tier table is built from.
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
 * Override at deploy time with `BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY`.
 */
export const BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY: number = envPositiveInt(
  'BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY',
  5_000_000
);

/**
 * GLOBAL velocity ceiling (gens per window) — the base the tier table is built
 * from, and the fallback for an app with no tighter tier.
 *
 * 🔴 RAISED 120 → 600 (10 gens/sec at the default 60s window). WHY the burst
 * ceiling can be generous WITHOUT weakening the anti-Sybil bound:
 *   - The DAILY SPEND cap is the real Sybil bound. At ~500 Buzz/gen, the
 *     5_000_000 Buzz/day ceiling is ≈10k gens/day ≈ 0.12 gens/sec SUSTAINED.
 *     A ring cannot out-spend that no matter how fast it fires — the money
 *     ceiling binds long before any plausible velocity ceiling does.
 *   - Velocity therefore exists for TWO narrower jobs: (a) bounding a BURST
 *     (a fan-out spike that would hammer the orchestrator faster than the daily
 *     counter can react), and (b) catching the 0-COST / cache-hit gens that add
 *     nothing to the Buzz total and are otherwise invisible to the daily cap.
 *     Both are served fine at 600.
 *   - Meanwhile 120/60s ≈ 2 gens/sec AGGREGATE is well INSIDE legitimate
 *     traffic: ~120 concurrent viewers each generating once a minute saturates
 *     it, and every further viewer gets an abuse rejection. That is a
 *     success-punishing ceiling, not a guardrail.
 *
 * Override with `BLOCK_APP_SPEND_VELOCITY_MAX_GENS`.
 */
export const BLOCK_APP_SPEND_VELOCITY_MAX_GENS: number = envPositiveInt(
  'BLOCK_APP_SPEND_VELOCITY_MAX_GENS',
  600
);

/**
 * The window (seconds) the velocity ceiling is measured over. Fixed bucket:
 * `floor(now/window)` — the standard fixed-window limiter. GLOBAL by design (it
 * is part of the Redis KEY shape, not a per-app limit), so it is deliberately
 * NOT tiered. Override with `BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS`.
 */
export const BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS: number = envPositiveInt(
  'BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS',
  60
);

/**
 * The velocity ceiling for an UNVERIFIED app — deliberately pinned at the
 * ORIGINAL 120 gens/window. An unverified app is one nobody has vetted, and it
 * is the tier every newly-registered app starts in, so it keeps the tight
 * pre-existing burst ceiling; the raise to 600 is something REVIEW grants.
 *
 * `Math.min` with the global keeps the invariant "unverified is never LOOSER
 * than the global" even when an operator tightens the global env override below
 * 120 in an incident.
 */
const UNVERIFIED_VELOCITY_MAX_GENS = Math.min(120, BLOCK_APP_SPEND_VELOCITY_MAX_GENS);

/**
 * Multiplier applied to BOTH global ceilings for the `internal` tier
 * (first-party / platform-built apps, assignable only by an admin). One knob so
 * spend and velocity "move together" — an operator retuning
 * `BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY` scales every tier coherently rather than
 * leaving the internal tier stranded at a stale absolute number.
 */
const INTERNAL_TIER_MULTIPLIER = 5;

/**
 * TIER → LIMITS. The whole table is derived from the two global env-overridable
 * bases above, so one deploy-time knob still moves everything together.
 *
 *   | tier       | dailyBuzz            | velocityMaxGens      |
 *   |------------|----------------------|----------------------|
 *   | unverified | 5,000,000 (global)   | 120  (pinned)        |
 *   | verified   | 5,000,000 (global)   | 600  (global)        |
 *   | internal   | 25,000,000 (5×)      | 3,000 (5×)           |
 *
 * 🔴 `unverified` is byte-identical to the PRE-CHANGE global behaviour
 * (5,000,000 / 120), and `trust_tier` defaults to `'unverified'` for every row
 * that exists today. So merging this changes NOTHING for any currently-live app
 * until a moderator promotes one — the loosening is opt-in, per app, and
 * reversible by flipping the tier back.
 */
export const APP_TIER_CAP_LIMITS: Readonly<Record<AppTrustTier, AppCapLimits>> = Object.freeze({
  unverified: {
    dailyBuzz: BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY,
    velocityMaxGens: UNVERIFIED_VELOCITY_MAX_GENS,
  },
  verified: {
    dailyBuzz: BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY,
    velocityMaxGens: BLOCK_APP_SPEND_VELOCITY_MAX_GENS,
  },
  internal: {
    dailyBuzz: BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY * INTERNAL_TIER_MULTIPLIER,
    velocityMaxGens: BLOCK_APP_SPEND_VELOCITY_MAX_GENS * INTERNAL_TIER_MULTIPLIER,
  },
});

/**
 * The CONSERVATIVE fallback: the per-field MINIMUM across the entire tier table.
 *
 * 🔴 Computed, not hardcoded, on purpose. Every "I don't know what this app is"
 * path resolves here — unknown tier string, NULL tier, missing app row, DB
 * error. Deriving it from the table means a future re-tune of the table cannot
 * silently make the fallback the LOOSEST option (which is exactly how a
 * fail-closed guard rots into a fail-open one).
 */
export const STRICTEST_APP_CAP_LIMITS: AppCapLimits = (() => {
  const all = Object.values(APP_TIER_CAP_LIMITS);
  return {
    dailyBuzz: Math.min(...all.map((l) => l.dailyBuzz)),
    velocityMaxGens: Math.min(...all.map((l) => l.velocityMaxGens)),
  };
})();

/**
 * Hard bounds on a moderator-set OVERRIDE. The zod input schema enforces these
 * at the router, and `normalizeCapOverride` re-enforces them at read time so a
 * value written straight into the DB (psql/retool — this DB does NOT auto-apply
 * migrations and IS edited by hand) still cannot express an effectively
 * unlimited app.
 *
 * `1_000_000_000` Buzz/day ≈ $1M/day; `100_000` gens/window ≈ 1,666 gens/sec at
 * the 60s default. Both are absurdly high for a real app — they exist purely so
 * "uncapped" remains unrepresentable, not as a tuning target.
 */
export const APP_CAP_OVERRIDE_MAX_DAILY_BUZZ = 1_000_000_000;
export const APP_CAP_OVERRIDE_MAX_VELOCITY_GENS = 100_000;

/** True iff `value` is one of the real, recognised trust tiers. */
export function isAppTrustTier(value: unknown): value is AppTrustTier {
  return typeof value === 'string' && (APP_TRUST_TIERS as readonly string[]).includes(value);
}

/**
 * The tier's limits, or `STRICTEST_APP_CAP_LIMITS` for anything unrecognised
 * (NULL / empty / a tier this build doesn't know about / a non-string). NEVER
 * returns an unbounded value.
 */
export function limitsForTier(tier: unknown): AppCapLimits {
  return isAppTrustTier(tier) ? APP_TIER_CAP_LIMITS[tier] : STRICTEST_APP_CAP_LIMITS;
}

/**
 * Normalise one raw override column value to a usable ceiling, or `undefined`
 * when the override does not apply (so the caller falls back to the tier).
 *
 * Rejected → `undefined`: NULL/undefined (the no-override case), a non-number,
 * NaN/Infinity, and anything that is `<= 0` AFTER flooring (0 would mean
 * "cannot generate at all" — that is a DISABLE decision, not a cap decision,
 * and the disable surface is the app's `status`). A value above `max` is
 * CLAMPED down to `max` rather than ignored, so a fat-fingered giant number
 * degrades to the hard bound instead of silently reverting to the tier.
 *
 * 🔴 FLOOR BEFORE the positivity check, not after. `0 < value < 1` passes a
 * naive `value > 0` test and then floors to 0 — a ceiling of ZERO, which
 * rejects every generation for that app with a rate-limit message and no
 * explanation. Ordering is the whole guard here.
 */
export function normalizeCapOverride(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  if (floored <= 0) return undefined;
  return Math.min(floored, max);
}

/** The shape the resolver reads off the `app_blocks` row. */
export type AppCapLimitsRow = {
  trustTier: string | null;
  spendCapBuzzPerDay: number | null;
  spendVelocityMaxGens: number | null;
};

/**
 * Resolve one app's effective limits from its row: start at the tier's limits,
 * then let each override column independently replace its field.
 *
 * An override may be LOWER than the tier as well as higher — tightening one
 * abusive app without demoting its tier (which also affects other, unrelated
 * gates) is a first-class use of this surface.
 */
export function resolveLimitsFromRow(row: AppCapLimitsRow): AppCapLimits {
  const base = limitsForTier(row.trustTier);
  const dailyOverride = normalizeCapOverride(
    row.spendCapBuzzPerDay,
    APP_CAP_OVERRIDE_MAX_DAILY_BUZZ
  );
  const velocityOverride = normalizeCapOverride(
    row.spendVelocityMaxGens,
    APP_CAP_OVERRIDE_MAX_VELOCITY_GENS
  );
  return {
    dailyBuzz: dailyOverride ?? base.dailyBuzz,
    velocityMaxGens: velocityOverride ?? base.velocityMaxGens,
  };
}
