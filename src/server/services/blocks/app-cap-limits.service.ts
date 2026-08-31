import type { AppCapLimitsDegradeReason } from '~/server/metrics/app-block-runtime.metrics';
import {
  APP_CAP_OVERRIDE_MAX_DAILY_BUZZ,
  APP_CAP_OVERRIDE_MAX_VELOCITY_GENS,
  normalizeCapOverride,
  resolveLimitsFromRow,
  STRICTEST_APP_CAP_LIMITS,
  type AppCapLimits,
} from '~/server/services/blocks/app-cap-limits.constants';

/**
 * PER-APP cap-limit RESOLUTION — the stateful half of the guardrail (the pure
 * tier table + fallback rules live in `app-cap-limits.constants.ts`).
 *
 * HOT PATH. `reserveAppSpend` calls `resolveAppCapLimits` on EVERY block-
 * initiated generation submit, so this must not become a per-submit DB read.
 * The posture (deliberately copied from `known-app-blocks.service.ts`, which
 * solves the same "cheap per-request lookup of a rarely-changing app row"
 * problem):
 *
 *   - PER-APP, TTL'd, in-process cache. A hit is a `Map.get` — no IO at all.
 *     A miss is ONE primary-key `findUnique` on `app_blocks`, so the steady-state
 *     cost is `ceil(active_apps / TTL)` PK lookups per pod, NOT one per submit.
 *   - SINGLE-FLIGHT per app id: concurrent misses for the same app share one
 *     in-flight query, so a cold pod under a burst issues one query, not N.
 *   - BOUNDED. The cache is capped at `CAP_LIMITS_MAX_ENTRIES` with
 *     oldest-first eviction (Map preserves insertion order), so it cannot grow
 *     into the heap-exhaustion class even if the app catalog does. (`appBlockId`
 *     arrives from a signature-verified block JWT, so it is not raw attacker
 *     input — the bound is belt-and-braces.)
 *   - `dbRead` is DYNAMICALLY imported, matching the sibling services, so this
 *     module adds no Prisma weight to the callers' static import graph.
 *
 * 🔴 FAIL-CLOSED, AND TOTAL. `resolveAppCapLimits` NEVER throws and NEVER
 * returns an unbounded value. A missing row, a DB outage, a garbage tier — all
 * resolve to `STRICTEST_APP_CAP_LIMITS`. Deliberately NOT a hard deny: the
 * strictest tier IS a real, enforced bound (it is today's shipped ceiling), so
 * degrading to it keeps the abuse guarantee intact, whereas denying every
 * generation on a DB blip would convert a transient database hiccup into a
 * total App-Blocks outage. The invariant this protects is "never uncapped" —
 * and that holds on every path.
 *
 * 🔴 …AND OBSERVABLE. Degrading silently is its own failure mode: an app pinned
 * to the strictest ceiling is indistinguishable from an app that is merely busy,
 * so the first signal would be its users hitting abuse rejections they did not
 * earn. Every degrade therefore emits BOTH
 *   - `civitai_app_block_cap_limits_degraded_total{reason}` — the alertable
 *     counter, `db_error` (infra) vs `missing_row` (no such app) — and
 *   - a `console.warn` carrying the specific `appBlockId`,
 * via `signalCapLimitsDegrade` below. See `app-block-runtime.metrics.ts` for why
 * the app id is in the LOG and not in a prom label.
 *
 * STALENESS. The cache is per-POD, so a moderator's override/tier change takes
 * effect within `CAP_LIMITS_TTL_MS` fleet-wide (`invalidateAppCapLimits` makes
 * it immediate only on the pod that served the write). One minute was chosen
 * over the sibling service's 5 minutes precisely because this is an incident
 * knob — a mod tightening an abusive app should not wait five minutes.
 */

/** How long a successfully-resolved app's limits are trusted (per pod). */
const CAP_LIMITS_TTL_MS = 60_000;

/**
 * How long a FALLBACK result (missing row / DB error) is cached. Short, so the
 * app recovers its real limits quickly once the DB is back or the row appears —
 * but non-zero, so a DB outage doesn't turn every submit into a fresh failing
 * query (a stampede on an already-sick database).
 */
const CAP_LIMITS_FALLBACK_TTL_MS = 5_000;

/** Hard entry bound on the in-process cache (oldest-first eviction). */
const CAP_LIMITS_MAX_ENTRIES = 2_000;

type CacheEntry = { limits: AppCapLimits; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<AppCapLimits>>();

function setCacheEntry(appBlockId: string, limits: AppCapLimits, ttlMs: number): void {
  // Evict oldest-first when at capacity (Map iterates in insertion order).
  if (!cache.has(appBlockId) && cache.size >= CAP_LIMITS_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(appBlockId, { limits, expiresAt: Date.now() + ttlMs });
}

/**
 * Emit the DEGRADE signal for one fallback-to-strictest resolution.
 *
 * 🔴 THE SIGNAL IS NOT A FAILURE PATH. Each emitter is independently guarded, so
 * a broken metrics registry cannot suppress the log, a throwing `console` cannot
 * suppress the metric, and neither can propagate into `resolveAppCapLimits` —
 * which must keep its "never throws, never uncapped" contract even while the
 * thing observing it is broken. (`recordAppCapLimitsDegrade` is ALSO total on
 * its own side; the duplication is deliberate — the guarantee must not depend on
 * either layer alone.)
 *
 * 🔴 NOT ON THE HOT PATH. `loadAppCapLimits` runs only on a cache MISS, and this
 * runs only on a miss that DEGRADED — a submit served from the warm cache, and a
 * miss that resolves a real row, never reach here.
 *
 * VOLUME. Bounded by the cache, not by traffic: a degrade is cached for
 * `CAP_LIMITS_FALLBACK_TTL_MS` (5s) and concurrent misses single-flight, so the
 * ceiling is `active_apps / 5s` per pod REGARDLESS of submit rate — a burst of
 * 10k submits against one degraded app emits once, not 10k times. The worst case
 * is a total DB outage (every active app degrading at once): at today's ~21 apps
 * that is ~4 lines/sec/pod, and in that scenario the DB-outage signal is the
 * point. If the app catalog reaches the thousands, this becomes the reason to
 * revisit the fallback TTL — noting the log already had exactly this cadence on
 * the `db_error` path before this change; only `missing_row` is newly logged.
 *
 * The metric emit is dynamically imported to keep prom-client out of the
 * deliberately-light static import graph of the spend-cap path (same reasoning
 * as the `dbRead` import above).
 */
async function signalCapLimitsDegrade(
  appBlockId: string,
  reason: AppCapLimitsDegradeReason,
  detail: string
): Promise<void> {
  try {
    const { recordAppCapLimitsDegrade } = await import(
      '~/server/metrics/app-block-runtime.metrics'
    );
    recordAppCapLimitsDegrade(reason);
  } catch {
    /* observability must never break the guardrail it observes */
  }
  try {
    // eslint-disable-next-line no-console
    console.warn(
      `[app-cap-limits] DEGRADED to the strictest tier for ${appBlockId} (reason=${reason}): ${detail}`
    );
  } catch {
    /* observability must never break the guardrail it observes */
  }
}

async function loadAppCapLimits(
  appBlockId: string
): Promise<{ limits: AppCapLimits; ttlMs: number }> {
  try {
    // Dynamic import so this module doesn't eager-load Prisma into the
    // (dynamically-imported, intentionally light) spend-cap path.
    const { dbRead } = await import('~/server/db/client');
    const row = await dbRead.appBlock.findUnique({
      where: { id: appBlockId },
      // 🔴 `trustTier` is deliberately NOT selected. It is the iframe-sandbox /
      // renderMode axis (browser isolation), not a spend authorisation — see the
      // constants module header. Spend reads `spendTier` and nothing else.
      select: { spendTier: true, spendCapBuzzPerDay: true, spendVelocityMaxGens: true },
    });
    if (!row) {
      // No such app (revoked mid-session, a synthetic dev id that slipped the
      // caller's `claims.dev` exclusion, a brand-new app racing its first
      // submit, …) → strictest. Never uncapped — but NOT silent: this is a
      // one-app, read-succeeded condition, which points at an id-minting bug
      // rather than at the database, so it gets its own reason.
      await signalCapLimitsDegrade(appBlockId, 'missing_row', 'no app_blocks row for this id');
      return { limits: STRICTEST_APP_CAP_LIMITS, ttlMs: CAP_LIMITS_FALLBACK_TTL_MS };
    }
    return { limits: resolveLimitsFromRow(row), ttlMs: CAP_LIMITS_TTL_MS };
  } catch (err) {
    // DB unreachable, or the override columns not yet applied to this
    // environment (this DB does NOT auto-apply migrations). Either way: fall
    // back to the strictest tier — which is the ceiling that was in force
    // before this feature — and signal so ops can see it. Distinct reason from
    // the missing-row case above: this one is INFRA and degrades every app at
    // once, so it is the alert an operator should be paged on.
    await signalCapLimitsDegrade(
      appBlockId,
      'db_error',
      err instanceof Error ? err.message : String(err)
    );
    return { limits: STRICTEST_APP_CAP_LIMITS, ttlMs: CAP_LIMITS_FALLBACK_TTL_MS };
  }
}

/**
 * The effective `{ dailyBuzz, velocityMaxGens }` ceilings for one app.
 *
 * NEVER throws (see the module header). NEVER returns an unbounded value.
 */
export async function resolveAppCapLimits(appBlockId: string): Promise<AppCapLimits> {
  const cached = cache.get(appBlockId);
  if (cached && cached.expiresAt > Date.now()) return cached.limits;

  const pending = inflight.get(appBlockId);
  if (pending) return pending;

  const promise = loadAppCapLimits(appBlockId)
    .then(({ limits, ttlMs }) => {
      setCacheEntry(appBlockId, limits, ttlMs);
      return limits;
    })
    // Belt for the (currently unreachable) case where the loader itself rejects
    // — the guarantee "resolveAppCapLimits never throws" must not depend on the
    // loader's internal try/catch staying exhaustive.
    .catch(() => STRICTEST_APP_CAP_LIMITS)
    .finally(() => {
      inflight.delete(appBlockId);
    });

  inflight.set(appBlockId, promise);
  return promise;
}

/**
 * Drop one app's cached limits so the next resolve re-reads the row. Called by
 * the moderator override write so the operator sees their change immediately on
 * the pod that served it; other pods converge within `CAP_LIMITS_TTL_MS`.
 */
export function invalidateAppCapLimits(appBlockId: string): void {
  cache.delete(appBlockId);
}

/** Test-only: clear all cached/in-flight state between cases. */
export function __resetAppCapLimitsCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Validate a moderator-supplied override pair before it is written. Returns the
 * normalised (floored + hard-bounded) values. `null` is a legitimate input
 * meaning "clear the override"; `undefined` means "leave unchanged".
 *
 * Mirrors `normalizeCapOverride`'s read-side rules so a value can never be
 * stored that the reader would then silently ignore.
 */
export function normalizeCapOverrideInput(opts: {
  spendCapBuzzPerDay?: number | null;
  spendVelocityMaxGens?: number | null;
}): { spendCapBuzzPerDay?: number | null; spendVelocityMaxGens?: number | null } {
  const out: { spendCapBuzzPerDay?: number | null; spendVelocityMaxGens?: number | null } = {};
  if (opts.spendCapBuzzPerDay !== undefined) {
    out.spendCapBuzzPerDay =
      opts.spendCapBuzzPerDay === null
        ? null
        : normalizeCapOverride(opts.spendCapBuzzPerDay, APP_CAP_OVERRIDE_MAX_DAILY_BUZZ) ?? null;
  }
  if (opts.spendVelocityMaxGens !== undefined) {
    out.spendVelocityMaxGens =
      opts.spendVelocityMaxGens === null
        ? null
        : normalizeCapOverride(opts.spendVelocityMaxGens, APP_CAP_OVERRIDE_MAX_VELOCITY_GENS) ??
          null;
  }
  return out;
}
