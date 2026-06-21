/**
 * Pure parser for the READINESS-only non-critical check list (shared-dependency park decouple).
 *
 * The readiness probe (/api/ready) can treat a SHARED dependency check (e.g. the cluster-redis
 * `redis` check) as non-fatal so a half-open park that wedges every pod's cluster client at once
 * cannot shed the WHOLE api-primary fleet from the LB (that capacity collapse IS the 504 wave).
 * This module turns the raw env list into a validated, deduped set of real check names so a typo
 * can't silently suppress the wrong check (or nothing at all).
 *
 * Leaf module with NO heavy imports (no db/redis/prom) so it is unit-testable in isolation and
 * importing it into ready.ts doesn't drag extra weight onto the probe path. Mirrors the
 * cluster-deadline-hits / command-deadline leaf-module pattern.
 */

/**
 * Filter a raw env list of check names down to the ones that actually exist, returning a deduped
 * array. Unknown names are dropped (a typo suppresses NOTHING rather than everything). Order of
 * `validKeys` is irrelevant — membership only.
 *
 * Generic over the check-key string-literal union so the caller keeps full type safety without
 * this module importing the (heavy) health.ts where CheckKey is declared.
 */
export function parseReadinessNonCritical<K extends string>(
  raw: readonly string[] | undefined,
  validKeys: readonly K[]
): K[] {
  if (!raw || raw.length === 0) return [];
  const valid = new Set<string>(validKeys);
  const seen = new Set<K>();
  const out: K[] = [];
  for (const name of raw) {
    const trimmed = name.trim();
    if (valid.has(trimmed) && !seen.has(trimmed as K)) {
      seen.add(trimmed as K);
      out.push(trimmed as K);
    }
  }
  return out;
}
