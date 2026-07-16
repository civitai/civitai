import semver from 'semver';

/**
 * Client-version SATURATION instrument for the superjson → devalue tRPC
 * serializer migration.
 *
 * WHY THIS EXISTS: Phase 2 of the migration flips the tRPC wire format to devalue
 * on 100% of traffic. That flip is only safe once the overwhelming majority of
 * live browser bundles are "Phase-1-capable" — i.e. they contain the union
 * deserializer (`unionDeserialize`) and can therefore decode a devalue response.
 * A pre-Phase-1 bundle still executing in a stale tab would throw on a devalue
 * response. Nothing currently exports the client-version distribution, so the
 * Phase-2 go/no-go gate is unmeasurable. This module defines the bucketing that
 * makes it measurable at BOUNDED cardinality (one boolean label, not the raw
 * version string).
 *
 * THE THRESHOLD. `x-client-version` is the web bundle's `package.json` version
 * (`next.config.mjs` injects `packageJson.version` as `process.env.version`,
 * sent by every web client — `src/utils/trpc.ts`). Version bumps are their own
 * commits, and a feature PR inherits whatever version the previous bump left in
 * `package.json`. The Phase-1 union deserializer merged while `package.json` read
 * `5.0.2079` — but a PRE-Phase-1 build also reported `5.0.2079` (the bump to 2079
 * predates the Phase-1 merge), so `5.0.2079` STRADDLES the boundary and is
 * ambiguous. The first version that is UNAMBIGUOUSLY Phase-1-capable — every build
 * reporting it contains the union deserializer — is the first bump AFTER the merge:
 * `5.0.2080`. (The first Phase-1 build to actually reach production reported
 * `5.0.2081`; `>= 5.0.2080` cleanly covers it and everything newer.)
 *
 * Bucketing `>= 5.0.2080` as capable is the SAFE (lower-bound) direction: the one
 * ambiguous version (2079) counts as not-capable, so saturation is never
 * over-reported and the gate can only err toward waiting longer.
 */
export const PHASE1_CLIENT_VERSION = '5.0.2080';

// Memoize the semver comparison. Every web tRPC procedure runs through the client
// -version middleware, and the set of distinct live client versions is tiny (a
// handful of deployed builds at once), so a Map keyed by the raw version string
// collapses a per-procedure semver parse into a single Map lookup after warmup.
// A size guard clears the cache if it ever grows unexpectedly (e.g. spoofed
// headers) so it can't become an unbounded leak.
const capabilityCache = new Map<string, boolean>();
const CAPABILITY_CACHE_MAX = 256;

/**
 * Whether a reported `x-client-version` belongs to a build that can decode the
 * union serializer (Phase-1-capable, i.e. `>= PHASE1_CLIENT_VERSION`).
 *
 * Missing / empty / `'unknown'` / unparseable versions are treated as NOT capable
 * (the conservative direction — an old bundle that can't even report a valid
 * version is certainly not Phase-1-capable).
 */
export function isPhase1CapableClientVersion(version: string | undefined | null): boolean {
  if (!version) return false;
  const cached = capabilityCache.get(version);
  if (cached !== undefined) return cached;

  const valid = semver.valid(version);
  const capable = valid ? semver.gte(valid, PHASE1_CLIENT_VERSION) : false;

  if (capabilityCache.size >= CAPABILITY_CACHE_MAX) capabilityCache.clear();
  capabilityCache.set(version, capable);
  return capable;
}

/** The bounded metric label value for a reported client version. */
export function phase1CapableLabel(version: string | undefined | null): 'true' | 'false' {
  return isPhase1CapableClientVersion(version) ? 'true' : 'false';
}

/** TEST-ONLY: drop the memo cache so a test can assert cold-path behavior. */
export function __resetCapabilityCacheForTests(): void {
  capabilityCache.clear();
}
