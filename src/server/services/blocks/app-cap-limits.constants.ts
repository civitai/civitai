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
 * WHAT REPLACES IT — limits derived from a DEDICATED, server-owned
 * `AppBlock.spendTier`, with an admin-set per-app override on top:
 *
 *     effective limits = override (per field, when set)
 *                        ELSE the app's spendTier's limits
 *                        ELSE the STRICTEST tier's limits   ← fail-closed
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY A DEDICATED FIELD, AND NOT `trustTier`
 * ─────────────────────────────────────────────────────────────────────────────
 * An earlier revision of this module derived the ceilings from `AppBlock.trustTier`.
 * That was wrong, and it was wrong in the dangerous direction.
 *
 * `trustTier` is a BROWSER-ISOLATION decision, not a money decision. It gates:
 *   - the iframe `sandbox` token allowlist, and specifically whether
 *     `allow-same-origin` may be combined with `allow-scripts`
 *     (`block-manifest-validator.service.ts` → `validateSandbox`), and
 *   - whether `renderMode` may be `inline`/`hybrid` (same file).
 * A moderator sets `internal` to answer "may this app's code run without an
 * origin boundary?" — a question with nothing to say about how much Buzz the app
 * may spend per day.
 *
 * Overloading it as spend authorisation meant a moderator granting a RENDERING
 * capability silently granted a 5× money ceiling, with nothing in the review
 * flow saying so. It was not hypothetical: production already carried 3 rows at
 * `trust_tier='internal'` (verified against the live civitai DB 2026-07-31 —
 * 3 `internal`, 18 `unverified`), all tiered for rendering long before a spend
 * cap existed. Reading them as spend grants would have jumped them from
 * 5,000,000/120 to 25,000,000/3,000 on merge, with no moderator action.
 *
 * So spend gets its own axis. `spendTier` and `trustTier` are independent by
 * construction: `AppCapLimitsRow` below cannot even REPRESENT a trust tier, the
 * resolver never selects that column, and the two vocabularies deliberately
 * share no value in common (a test pins that) so one can never be silently
 * passed where the other is expected.
 *
 * 🔴 `spendTier` is the PLATFORM's decision, never the developer's claim. It is
 * a DB column only — it does not appear in the manifest schema, in any
 * publisher-facing tRPC input, or in the `/api/v1/developer/block-manifests`
 * payload, so there is no developer-reachable path that sets it. The only write
 * surface is `BlockRegistry.setAppSpendCapConfig`, behind `moderatorProcedure`.
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
 * The `AppBlock.spendTier` values — the SPEND axis, deliberately named so that
 * no value collides with a `trustTier` value (`unverified`/`verified`/`internal`).
 * The disjointness is enforced by a test: it is what makes a copy-paste of one
 * field into the other fail loudly (falling back to STRICTEST) instead of
 * resolving to a plausible-looking wrong ceiling.
 *
 * 🔴 The column is a String with a `'standard'` default, NOT a DB enum — a row
 * CAN carry a value outside this list (a hand-written UPDATE, a tier added to a
 * newer build and read by an older pod). That is exactly why
 * `limitsForSpendTier` treats anything unrecognised as the strictest tier
 * instead of assuming membership.
 */
export const APP_SPEND_TIERS = ['standard', 'trusted', 'platform'] as const;
export type AppSpendTier = (typeof APP_SPEND_TIERS)[number];

/**
 * The tier every app starts in and every row that exists today carries — the
 * `spend_tier` column's DB default. Its limits are byte-identical to the
 * ceilings in force before this feature, which is what makes the migration a
 * genuine no-op for every live app regardless of its `trustTier`.
 */
export const DEFAULT_APP_SPEND_TIER: AppSpendTier = 'standard';

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
 * Parse one env var as a positive integer, or `undefined` when it is unset /
 * unparseable / non-finite / zero / negative — so a typo in a deploy env can
 * never disable a cap; it falls through to a sane positive ceiling instead.
 */
function parsePositiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Parse a positive-integer env override, fail-safe. Unset / unparseable /
 * non-finite / zero / negative → the built-in default, so a sane positive
 * ceiling is ALWAYS in force and a typo in a deploy env can never disable a cap.
 * (Identical semantics to the original inline parsers — preserved verbatim so
 * `BLOCK_APP_SPEND_*` env vars keep working exactly as documented.)
 */
function envPositiveInt(name: string, fallback: number): number {
  return parsePositiveInt(process.env[name]) ?? fallback;
}

/**
 * As `envPositiveInt`, but ALSO honours a DEPRECATED legacy env name.
 *
 * 🔴 WHY A COMPAT PATH AT ALL. The two absolute-ceiling knobs were renamed
 * because their old names lied about what they now do (see the ceiling constants
 * below). `civitai-dp-prod` sets neither — verified 2026-07-31 — but these are
 * SPEND GUARDRAILS, and other environments are not enumerable from here.
 * Silently ignoring a value an operator deliberately set on a spend guardrail is
 * the worst possible outcome of a rename: they would believe a clamp is in force
 * that is not. So the legacy name keeps working, loudly.
 *
 * PRECEDENCE (a valid new value always wins):
 *   1. `name` parses to a positive int   → use it. If `legacyName` is ALSO set,
 *      warn that it is being ignored — a set-but-overridden guardrail var must
 *      not be silent either.
 *   2. else `legacyName` parses          → use it, and warn that it is
 *      deprecated. (Reached when `name` is unset OR set to an unusable value:
 *      an unusable value carries no operator intent, so it must not shadow one
 *      that does.)
 *   3. else                              → the built-in default. If
 *      `legacyName` was set but unusable, warn — otherwise a typo'd clamp is
 *      indistinguishable from no clamp.
 */
function envPositiveIntWithLegacy(name: string, legacyName: string, fallback: number): number {
  const fromNew = parsePositiveInt(process.env[name]);
  const legacyRaw = process.env[legacyName];
  const legacyPresent = legacyRaw !== undefined;
  const fromLegacy = parsePositiveInt(legacyRaw);

  if (fromNew !== undefined) {
    if (legacyPresent) {
      // eslint-disable-next-line no-console
      console.warn(
        `[app-cap-limits] ${legacyName} is DEPRECATED and IGNORED here: ${name} is also set and takes precedence (using ${fromNew}). Remove ${legacyName}.`
      );
    }
    return fromNew;
  }

  if (fromLegacy !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(
      `[app-cap-limits] ${legacyName} is DEPRECATED — rename it to ${name}. Honouring the legacy value ${fromLegacy} for now. 🔴 Its MEANING changed: it is an ABSOLUTE CEILING that clamps every spend tier AND every per-app override, not the limit an app receives.`
    );
    return fromLegacy;
  }

  if (legacyPresent) {
    // eslint-disable-next-line no-console
    console.warn(
      `[app-cap-limits] ${legacyName} (DEPRECATED) is set to an unusable value ${JSON.stringify(
        legacyRaw
      )} and ${name} is unset — falling back to the built-in default ${fallback}. NO deploy-time clamp is in force.`
    );
  }
  return fallback;
}

/**
 * The ceilings that were IN FORCE IN PRODUCTION before this feature: one global
 * pair applied to every app. Verified 2026-07-31 — `civitai-dp-prod` sets
 * neither of the two absolute-ceiling env knobs below (under their new
 * `BLOCK_APP_SPEND_ABSOLUTE_MAX_*` names or their deprecated legacy ones),
 * so the shipped defaults below were the live numbers.
 *
 * 🔴 These are a COMPATIBILITY PIN, not a tuning target. They are the
 * `standard` tier — the DB default for every row — so that applying the
 * migration and deploying this code changes the enforced ceiling for exactly
 * zero live apps. Re-tuning them is a deliberate, user-visible change.
 */
export const SHIPPED_APP_DAILY_BUZZ_CEILING = 5_000_000;
export const SHIPPED_APP_VELOCITY_MAX_GENS = 120;

/**
 * Hard bounds on any per-app ceiling — the highest number this system is
 * willing to express, whether it arrives via a tier, a moderator override, or a
 * hand-written row.
 *
 * 🔴 SINGLE-SOURCED. These exact numbers appear in four places, and all four
 * derive from here: the zod input schema (`setAppSpendCapConfigSchema`), the
 * read-time `normalizeCapOverride` clamp, the `CHECK` constraints in migration
 * `20260731120000_app_block_spend_tier_and_cap_override`, and the default value
 * of the global env ceilings below. The DB constraint matters because an
 * INTEGER column accepts up to 2,147,483,647: a hand-written `2000000000` would
 * pass a bare `> 0` check, be silently clamped at enforcement, and be reported
 * back RAW by the moderator read — three different numbers for one value.
 * Matching the bounds exactly means the DB REJECTS such a value instead of
 * storing a lie.
 *
 * `1_000_000_000` Buzz/day ≈ $1M/day; `100_000` gens/window ≈ 1,666 gens/sec at
 * the 60s default. Both are absurdly high for a real app — they exist purely so
 * "uncapped" remains unrepresentable, not as a tuning target.
 */
export const APP_CAP_OVERRIDE_MAX_DAILY_BUZZ = 1_000_000_000;
export const APP_CAP_OVERRIDE_MAX_VELOCITY_GENS = 100_000;

/**
 * GLOBAL ABSOLUTE CEILING on the per-app daily Buzz spend — the value NO tier
 * and NO override may exceed. The deploy-time incident knob.
 *
 * 🔴 SEMANTICS: this is a CEILING, not a base to multiply from. Every tier in
 * the table below is `Math.min(tier target, this)`, and `resolveLimitsFromRow`
 * applies it again AFTER any per-app override — so an operator who clamps this
 * in an incident tightens EVERY app, including the loosest tier and including
 * one carrying a per-app override written last week. (The earlier revision
 * computed the top tier as `global × 5`, which meant clamping the global to 50
 * produced a top tier of 250 — 5× LOOSER than the clamp just applied, while the
 * file advertised the opposite. That is the bug this shape removes.)
 *
 * 🔴 It DEFAULTS to the hard bound, i.e. to "no additional clamp". That is
 * deliberate: unset, this knob changes nothing and a moderator's override means
 * exactly what they typed (the schema maximum and the enforced maximum agree).
 * Set it, and it binds everything from above. A knob whose default silently
 * overrode moderator intent would be a footgun; a knob that only bites when an
 * operator reaches for it is an incident control.
 *
 * Sizing context for the tier table below, relative to the per-user cap: the
 * per-user ceiling is `BLOCK_BUZZ_CAP_PER_DAY = 50_000` Buzz/day ≈ $50/day
 * (yellow Buzz at 1000 = $1). One app serves many users, so the per-app
 * aggregate must be a generous multiple — the 5,000,000 `standard` tier is ≈
 * the aggregate spend of ~100 fully-maxed legitimate users through one app.
 *
 * Override at deploy time with `BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY`
 * (legacy name `BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY` still honoured — see
 * `envPositiveIntWithLegacy` and the deprecated alias below).
 */
export const BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY: number = envPositiveIntWithLegacy(
  'BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY',
  'BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY',
  APP_CAP_OVERRIDE_MAX_DAILY_BUZZ
);

/**
 * GLOBAL ABSOLUTE CEILING on the per-app velocity (gens per window) — the value
 * NO tier and NO override may exceed. Same "ceiling, not a base, defaults to
 * the hard bound" semantics as the daily knob above.
 *
 * WHY the burst ceiling can be generous for a REVIEWED app without weakening
 * the anti-Sybil bound:
 *   - The DAILY SPEND cap is the real Sybil bound. At ~500 Buzz/gen, the
 *     5,000,000 Buzz/day `standard` ceiling is ≈10k gens/day ≈ 0.12 gens/sec
 *     SUSTAINED. A ring cannot out-spend that no matter how fast it fires — the
 *     money ceiling binds long before any plausible velocity ceiling does.
 *   - Velocity therefore exists for TWO narrower jobs: (a) bounding a BURST
 *     (a fan-out spike that would hammer the orchestrator faster than the daily
 *     counter can react), and (b) catching the 0-COST / cache-hit gens that add
 *     nothing to the Buzz total and are otherwise invisible to the daily cap.
 *   - Meanwhile 120/60s ≈ 2 gens/sec AGGREGATE is well INSIDE legitimate
 *     traffic: ~120 concurrent viewers each generating once a minute saturates
 *     it, and every further viewer gets an abuse rejection. That is a
 *     success-punishing ceiling, not a guardrail — which is why review can lift
 *     an app off it, per app, rather than the platform lifting it for everyone.
 *
 * 🔴 `standard` stays pinned at 120 regardless of this value, so raising this
 * knob does NOT loosen any existing app; only a moderator promoting an app's
 * `spendTier` does. Lowering it tightens everything.
 *
 * Override with `BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW` (legacy name
 * `BLOCK_APP_SPEND_VELOCITY_MAX_GENS` still honoured). The window is
 * `BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS` below.
 */
export const BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW: number = envPositiveIntWithLegacy(
  'BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW',
  'BLOCK_APP_SPEND_VELOCITY_MAX_GENS',
  APP_CAP_OVERRIDE_MAX_VELOCITY_GENS
);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPRECATED ALIASES — the pre-rename export names.
 * ─────────────────────────────────────────────────────────────────────────────
 * Same values, kept so existing importers (and their tests) keep compiling while
 * the rename settles. 🔴 Prefer the `..._ABSOLUTE_MAX_...` names: they are what
 * the ENV VARS are now called, so a grep for the variable an operator typed
 * lands on the code that reads it — which is the whole point of the rename.
 *
 * WHY THE NAMES WERE WRONG. Before the per-app tier work these two WERE the
 * ceilings — one global pair applied to every app, so `..._VELOCITY_MAX_GENS`
 * genuinely was "the max gens". They are now an ABSOLUTE bound that clamps the
 * tier table AND any per-app moderator override from above. An operator reaching
 * for `..._VELOCITY_MAX_GENS` mid-incident would reasonably read it as "set the
 * limit to X" when it actually means "nothing may exceed X" — the same string,
 * two different mental models, one of which quietly does nothing if the app's
 * tier is already below X.
 */
/** @deprecated Use {@link BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY}. */
export const BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY: number = BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY;
/** @deprecated Use {@link BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW}. */
export const BLOCK_APP_SPEND_VELOCITY_MAX_GENS: number =
  BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW;

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
 * The tiers' TARGET limits, before the global ceilings are applied. Absolute
 * numbers rather than multiples of a moving base, so that (a) `standard` can be
 * pinned to the pre-change shipped ceilings exactly, and (b) the global knobs
 * can act as pure downward clamps.
 */
const APP_SPEND_TIER_TARGETS: Readonly<Record<AppSpendTier, AppCapLimits>> = Object.freeze({
  /**
   * Every app, until a moderator says otherwise — and the DB default, so this
   * is what all 21 rows that exist today resolve to. Pinned at the pre-change
   * shipped ceilings.
   */
  standard: {
    dailyBuzz: SHIPPED_APP_DAILY_BUZZ_CEILING,
    velocityMaxGens: SHIPPED_APP_VELOCITY_MAX_GENS,
  },
  /**
   * An app a moderator has reviewed for SPEND behaviour: same money ceiling,
   * 5× the burst headroom (600/60s = 10 gens/sec aggregate). This is the tier
   * that fixes the "success-punishing ceiling" problem for a popular app.
   */
  trusted: {
    dailyBuzz: SHIPPED_APP_DAILY_BUZZ_CEILING,
    velocityMaxGens: 600,
  },
  /**
   * First-party / platform-operated apps. 5× the money ceiling and 25× the
   * burst ceiling. Granting this is an explicit spend decision — it is NOT
   * implied by, and does not imply, `trustTier='internal'`.
   */
  platform: {
    dailyBuzz: 25_000_000,
    velocityMaxGens: 3_000,
  },
});

/**
 * SPEND TIER → LIMITS, with the global ceilings applied per field.
 *
 *   | spendTier | dailyBuzz            | velocityMaxGens      |
 *   |-----------|----------------------|----------------------|
 *   | standard  | 5,000,000  (pinned)  | 120  (pinned)        |
 *   | trusted   | 5,000,000            | 600                  |
 *   | platform  | 25,000,000           | 3,000                |
 *
 * every cell additionally `min`'d with the corresponding
 * `BLOCK_APP_SPEND_*` global, so no tier can ever exceed the deploy-time clamp.
 *
 * 🔴 `standard` is byte-identical to the PRE-CHANGE global behaviour
 * (5,000,000 / 120) and is the `spend_tier` DB default for every row — INCLUDING
 * the three rows already sitting at `trust_tier='internal'`, which this axis
 * deliberately does not look at. So applying the migration and merging this
 * changes NOTHING for any currently-live app until a moderator promotes one.
 */
export const APP_SPEND_TIER_CAP_LIMITS: Readonly<Record<AppSpendTier, AppCapLimits>> =
  Object.freeze(
    Object.fromEntries(
      APP_SPEND_TIERS.map((tier) => {
        const target = APP_SPEND_TIER_TARGETS[tier];
        return [
          tier,
          {
            dailyBuzz: Math.min(target.dailyBuzz, BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY),
            velocityMaxGens: Math.min(
              target.velocityMaxGens,
              BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW
            ),
          },
        ];
      })
    ) as Record<AppSpendTier, AppCapLimits>
  );

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
  const all = Object.values(APP_SPEND_TIER_CAP_LIMITS);
  return {
    dailyBuzz: Math.min(...all.map((l) => l.dailyBuzz)),
    velocityMaxGens: Math.min(...all.map((l) => l.velocityMaxGens)),
  };
})();

/** True iff `value` is one of the real, recognised SPEND tiers. */
export function isAppSpendTier(value: unknown): value is AppSpendTier {
  return typeof value === 'string' && (APP_SPEND_TIERS as readonly string[]).includes(value);
}

/**
 * The spend tier's limits, or `STRICTEST_APP_CAP_LIMITS` for anything
 * unrecognised (NULL / empty / a tier this build doesn't know about / a
 * non-string — including a `trustTier` value accidentally written into the
 * column, which shares no value with this vocabulary). NEVER returns an
 * unbounded value.
 */
export function limitsForSpendTier(tier: unknown): AppCapLimits {
  return isAppSpendTier(tier) ? APP_SPEND_TIER_CAP_LIMITS[tier] : STRICTEST_APP_CAP_LIMITS;
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
 * (With the migration's CHECK constraints applied, an out-of-bounds value can
 * no longer reach the column at all — this clamp is the defence that still
 * holds in an environment where the constraint has not been applied yet.)
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

/**
 * The shape the resolver reads off the `app_blocks` row.
 *
 * 🔴 `trustTier` is DELIBERATELY ABSENT and must stay absent. Spend is its own
 * axis (see the module header); making the browser-isolation tier
 * unrepresentable here is what stops it being read back into a money decision
 * by a later edit.
 */
export type AppCapLimitsRow = {
  spendTier: string | null;
  spendCapBuzzPerDay: number | null;
  spendVelocityMaxGens: number | null;
};

/**
 * Resolve one app's effective limits from its row: start at the spend tier's
 * limits, then let each override column independently replace its field.
 *
 * An override may be LOWER than the tier as well as higher — tightening one
 * abusive app without demoting its tier is a first-class use of this surface.
 *
 * 🔴 The GLOBAL ceilings are applied LAST, after the override. An operator who
 * clamps `BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW=50` during an incident must
 * out-ranked by a per-app override written last week — the deploy-time knob is
 * the outermost bound on every path, tier and override alike. (The moderator
 * read surface returns the raw override alongside the effective pair, so a
 * clamp is visible rather than silent.)
 */
export function resolveLimitsFromRow(row: AppCapLimitsRow): AppCapLimits {
  const base = limitsForSpendTier(row.spendTier);
  const dailyOverride = normalizeCapOverride(
    row.spendCapBuzzPerDay,
    APP_CAP_OVERRIDE_MAX_DAILY_BUZZ
  );
  const velocityOverride = normalizeCapOverride(
    row.spendVelocityMaxGens,
    APP_CAP_OVERRIDE_MAX_VELOCITY_GENS
  );
  return {
    dailyBuzz: Math.min(dailyOverride ?? base.dailyBuzz, BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY),
    velocityMaxGens: Math.min(
      velocityOverride ?? base.velocityMaxGens,
      BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW
    ),
  };
}
