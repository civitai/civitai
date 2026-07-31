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

async function loadAppCapLimits(
  appBlockId: string
): Promise<{ limits: AppCapLimits; ttlMs: number }> {
  try {
    // Dynamic import so this module doesn't eager-load Prisma into the
    // (dynamically-imported, intentionally light) spend-cap path.
    const { dbRead } = await import('~/server/db/client');
    const row = await dbRead.appBlock.findUnique({
      where: { id: appBlockId },
      select: { trustTier: true, spendCapBuzzPerDay: true, spendVelocityMaxGens: true },
    });
    if (!row) {
      // No such app (revoked mid-session, a synthetic dev id that slipped the
      // caller's `claims.dev` exclusion, …) → strictest. Never uncapped.
      return { limits: STRICTEST_APP_CAP_LIMITS, ttlMs: CAP_LIMITS_FALLBACK_TTL_MS };
    }
    return { limits: resolveLimitsFromRow(row), ttlMs: CAP_LIMITS_TTL_MS };
  } catch (err) {
    // DB unreachable, or the override columns not yet applied to this
    // environment (this DB does NOT auto-apply migrations). Either way: fall
    // back to the strictest tier — which is the ceiling that was in force
    // before this feature — and log so ops can see it.
    // eslint-disable-next-line no-console
    console.warn(
      `[app-cap-limits] limit lookup failed for ${appBlockId}; falling back to the strictest tier: ${
        err instanceof Error ? err.message : String(err)
      }`
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
