/**
 * RUM geo session attributes — carry a coarse geography dimension on every Faro RUM
 * beacon so web-vitals/latency can be split by region in Loki.
 *
 * WHY THIS EXISTS: Faro RUM is at 100% of users, but the beacons carry NO geography
 * dimension — there is no region/country/timezone field anywhere in the faro-rum stream.
 * A per-region latency or web-vitals split (e.g. "is GB slower than US since deploy X")
 * is therefore UNMEASURABLE from RUM. This module produces two session attributes which
 * FaroProvider sets as Faro session metadata at init:
 *   - `region` — the user's country code, SSR-DERIVED (`getRegion` in
 *     src/server/utils/region-blocking.ts reads `cf-ipcountry`/`cf-region-code`/`x-isuk`).
 *     _app already computes it (it feeds ThirdPartyConsentProvider); FaroProvider threads
 *     the SAME value in as a prop — nothing is re-parsed and nothing is fetched client-side.
 *   - `timezone` — the browser's IANA timezone from
 *     `Intl.DateTimeFormat().resolvedOptions().timeZone`, computed here at build time of the
 *     attributes (which happens in the client-side init path only).
 *
 * MECHANISM (same as experimentFlags.ts — read that doc comment for the full picture):
 *   - These attributes are passed to `initializeFaro` as `sessionTracking.session.attributes`.
 *     The Faro session manager merges them onto the session meta at session CREATION — so they
 *     are present BEFORE the first beacon and ride on `meta.session.attributes` of EVERY
 *     beacon type (exceptions, web-vitals, events, resource_timing).
 *   - Alloy's `faro.receiver` maps session `attributes` with prefix `attr_`, so these land in
 *     Loki as the logfmt fields **`session_attr_region`** and **`session_attr_timezone`**.
 *
 * ALWAYS SET — BOTH KEYS, EVERY CALL: an attribute that is ABSENT from a session simply does
 * not appear as a field on that session's Loki lines, and logfmt grouping
 * (`| logfmt | by (region)`) silently DROPS those lines from the grouping. Absence must be a
 * VALUE, not a missing field — so empty/null/whitespace country codes and any timezone
 * resolution failure all emit the literal string `unknown`, and both keys are emitted
 * unconditionally. This is the same "the off cohort must be queryable too" rule
 * experimentFlags.ts applies to flag values.
 *
 * PII/SAFETY: a 2-letter country code and an IANA timezone name are a COARSE location signal
 * — standard RUM practice (Boomerang/GA-class) and non-identifying at the individual level.
 * Both are plain alphanumeric/slash strings that match none of the `deepRedact` PII patterns
 * (no emails, no JWTs, no token-shaped separators — never add any here), so they pass through
 * the `beforeSend` scrub untouched (pinned by a redact test).
 *
 * CARDINALITY: two bounded dimensions. The country code is uppercased (Cloudflare emits
 * uppercase; its special 2-char tokens like `XX`/`T1` pass through as their own bucket rather
 * than being flattened into `unknown`). The IANA timezone name is kept RAW (e.g.
 * `America/New_York`) — it is already a bounded enum (~400 zones); do not case-normalize it.
 */

/** Session-attribute key for the SSR-derived country code → Loki field `session_attr_region`. */
export const GEO_REGION_ATTR = 'region';

/** Session-attribute key for the client IANA timezone → Loki field `session_attr_timezone`. */
export const GEO_TIMEZONE_ATTR = 'timezone';

/** Value emitted whenever the real value is absent, empty or unresolvable. */
export const GEO_UNKNOWN_VALUE = 'unknown';

/**
 * Normalize the SSR-derived country code to its Loki-safe form: trimmed + uppercased, or
 * `unknown` for null/empty/whitespace. Uppercasing matches how Cloudflare emits
 * `cf-ipcountry` and how the dev override normalizes, so this is idempotent on real values.
 */
function sanitizeCountryCode(countryCode: string | null | undefined): string {
  return countryCode?.trim().toUpperCase() || GEO_UNKNOWN_VALUE;
}

/**
 * Resolve the browser's IANA timezone. Throws are swallowed to `unknown` (an exotic
 * Intl failure must never break RUM init — this runs on the critical client path).
 */
function resolveClientTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || GEO_UNKNOWN_VALUE;
  } catch {
    return GEO_UNKNOWN_VALUE;
  }
}

/**
 * Build the geo session attributes. Returns BOTH keys ALWAYS SET (see the always-set rule
 * above) — the returned map is spread VERBATIM into `initializeFaro`'s
 * `sessionTracking.session.attributes` by FaroProvider, so testing this output IS testing
 * what rides on every beacon.
 *
 * The timezone is computed here ONLY when a `window` exists: this builder is called from the
 * client-side init path (FaroProvider's effect), but on a server render there is no browser
 * timezone to resolve — there the value is `unknown` while `region` is still set.
 *
 * PURE + unit-tested (`__tests__/geoAttributes.test.ts`).
 */
export function buildRumGeoAttributes(
  countryCode: string | null | undefined
): Record<string, string> {
  const attributes: Record<string, string> = {
    [GEO_REGION_ATTR]: sanitizeCountryCode(countryCode),
  };
  attributes[GEO_TIMEZONE_ATTR] =
    typeof window !== 'undefined' ? resolveClientTimezone() : GEO_UNKNOWN_VALUE;
  return attributes;
}
