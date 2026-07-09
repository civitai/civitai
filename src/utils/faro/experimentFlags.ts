import type { FeatureAccess, FeatureFlagKey } from '~/server/services/feature-flags.service';

/**
 * RUM experiment segmentation — carry the value of a CURATED set of feature flags on every
 * Faro RUM beacon so flag-on vs flag-off cohorts are separable in Loki.
 *
 * WHY THIS EXISTS: Faro RUM is at 100% of users, but the beacons carry NO feature-flag
 * dimension. So a flag-gated A/B experiment (e.g. `feedReserveCls`, the announcement-CLS-reserve
 * flag ramped to 25% via Flipt) is UNMEASURABLE from RUM — CLS/LCP/exception beacons land in
 * Loki with no way to split the flag-on cohort from flag-off. This module produces a small,
 * curated set of `exp_*` session attributes from the resolved feature flags, which FaroProvider
 * sets as Faro session metadata at init.
 *
 * MECHANISM + THE LOKI FIELD IT PRODUCES (verified against the Alloy `faro.receiver` source):
 *   - These attributes are passed to `initializeFaro` as `sessionTracking.session.attributes`.
 *     The Faro session manager merges them onto the session meta at session creation (alongside
 *     the generated session id + `isSampled`) — so they are present BEFORE the first beacon and
 *     ride on `meta.session.attributes` of EVERY beacon type (exceptions, web-vitals
 *     measurements, events, resource_timing).
 *   - Alloy's `faro.receiver` maps `Meta.Session` with prefix `session_` and the session's
 *     `attributes` map with prefix `attr_` (see `Meta.KeyVal` / `Session.KeyVal` in
 *     grafana/alloy `.../faro/receiver/internal/payload/payload.go`). So attribute
 *     `exp_feed_reserve_cls` lands in Loki as the logfmt field **`session_attr_exp_feed_reserve_cls`**.
 *     NOTE: this is `session_attr_*`, NOT `context_*`. The `context_*` prefix is reserved for a
 *     BEACON's OWN payload context (e.g. resource_timing's `context_route`, web-vitals'
 *     `context_largest_shift_target`) — those are set per-push by the instrumentation that emits
 *     them and cannot be set globally. Session meta is the only surface that reliably lands on
 *     web-vitals + exception beacons, which is exactly the measurement need here.
 *
 * TIMING: because the attributes are baked into the session at creation (during
 * `initializeFaro`, before any signal is sent), ALL beacon types carry them — including LCP
 * (early) and CLS/INP (finalized at page-hide/unload). There is no early-beacon gap: session
 * meta is snapshotted at beacon-emit time, and emit always happens after session creation.
 *
 * PII/SAFETY: only curated flags, only boolean values coerced to the strings `"true"`/`"false"`.
 * Nothing user-identifying. (MetaAttributes must be strings.) These values match none of the
 * `deepRedact` PII patterns, so they pass through the `beforeSend` scrub untouched. Adding a
 * flag here does NOT bypass redaction — but keep this list to non-identifying experiment gates
 * only.
 *
 * REUSABILITY: to add a future RUM experiment, add ONE entry to `RUM_EXPERIMENT_FLAGS` — the
 * feature-flag key + the explicit `exp_*` attribute name. Explicit (not derived) attribute
 * names keep the Loki field greppable and stable, and avoid a camelCase→snake_case heuristic.
 */

/** Prefix on every RUM-experiment session attribute, so the Loki field is greppable. */
export const RUM_EXPERIMENT_ATTR_PREFIX = 'exp_';

/**
 * CURATED allowlist of feature flags whose value is carried on RUM beacons. This is
 * DELIBERATELY a small hand-picked set — do NOT dump all feature flags onto beacons
 * (cardinality, PII, noise). Add one entry per active experiment.
 *
 * `flag` — the FeatureAccess key to read.
 * `attr` — the session-attribute name (`exp_*`) → Loki field `session_attr_<attr>`.
 */
export const RUM_EXPERIMENT_FLAGS = [
  { flag: 'feedReserveCls', attr: 'exp_feed_reserve_cls' },
  { flag: 'genTabDeferView', attr: 'exp_gen_tab_defer_view' },
] as const satisfies ReadonlyArray<{ flag: FeatureFlagKey; attr: string }>;

/**
 * Build the `exp_*` session attributes from the resolved feature flags. Emits BOTH cohorts
 * (`"true"` and `"false"`) for every curated flag so the flag-OFF cohort is queryable too (an
 * absent field can't be distinguished from "no data"). Only allowlisted flags are emitted; a
 * flag missing from `features` is treated as off (`"false"`).
 *
 * PURE + unit-tested (`__tests__/experimentFlags.test.ts`).
 */
export function buildRumExperimentAttributes(
  features: Partial<FeatureAccess>
): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const { flag, attr } of RUM_EXPERIMENT_FLAGS) {
    attributes[attr] = String(!!features[flag]);
  }
  return attributes;
}
