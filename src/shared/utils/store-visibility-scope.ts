/**
 * The App-store read VISIBILITY SCOPE — its closed value set, and the ONE
 * narrowing rule every consumer applies to an untrusted / possibly-absent scope.
 *
 * ## Why this lives in its own dependency-free module (civitai#3983)
 *
 * The scope is produced in one place (`resolveStoreVisibilityScope`) and branched
 * on in five (the three store tRPC procs, both `/api/v1/apps*` REST handlers) plus
 * the two data-layer entry points (`listAvailableListings` / `getListingDetail`).
 * Before this module each of those sites carried its OWN default for "no scope
 * arrived", and they did not agree:
 *
 *   - the tRPC procs defaulted an absent scope to `none`  → an EMPTY store;
 *   - the listing service defaulted it to `full`          → the WHOLE catalog.
 *
 * So a single missing value produced two opposite failures, and the one that
 * widened access was the silent one: an anonymous caller received the full
 * approved catalog — on-site apps included — from a public REST endpoint, while
 * looking exactly like a working feature. That is civitai#3983.
 *
 * 🔴 A DEFAULT IS A SECURITY DECISION. `?? 'full'` is not a convenience; it is an
 * authorization grant issued by whatever code forgot to pass an argument. There is
 * one correct default for an absent or unrecognized scope and it is `none` — the
 * caller sees nothing. {@link narrowStoreScope} is that rule, in one place, so a
 * new consumer cannot re-derive a different one.
 *
 * ## Why a runtime guard rather than the type
 *
 * `StoreVisibilityScope` is a compile-time union; every producer and consumer here
 * already type-checks green while production carries `undefined` across the same
 * boundary. A declared type is not a code path — only a branch on the value is —
 * so the check has to exist at runtime, at the branch, on every path that can
 * widen access.
 *
 * This module deliberately imports NOTHING: it is reachable from the server data
 * layer, the REST handlers, the tRPC router and the client, and must never drag a
 * server dependency into any of them.
 */

/** The closed value set. The runtime source of truth for the type below. */
export const STORE_VISIBILITY_SCOPES = ['full', 'public-external', 'none'] as const;

/**
 * The store read-path VISIBILITY SCOPE resolved once per request, then threaded
 * into every store read proc + the data-layer kind predicate:
 *   - `full`            — the caller sees ALL kinds.
 *   - `public-external` — the caller sees ONLY `kind='offsite'` approved listings
 *     (both `connect` and `external-link` sub-kinds); onsite is excluded.
 *   - `none`            — the caller sees NOTHING (dark; the public default).
 */
export type StoreVisibilityScope = (typeof STORE_VISIBILITY_SCOPES)[number];

/** Runtime membership test for the closed set above. */
export function isStoreVisibilityScope(value: unknown): value is StoreVisibilityScope {
  return (
    typeof value === 'string' && (STORE_VISIBILITY_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * Narrow an untrusted, absent or unrecognized scope to a real one, FAILING CLOSED.
 *
 * 🔴 Every value that is not exactly one of {@link STORE_VISIBILITY_SCOPES} maps to
 * `none` — `undefined`, `null`, a typo, a scope from a future branch this build
 * does not understand. Never to `full`, and never to `public-external`: a value we
 * cannot interpret is not evidence of an entitlement.
 *
 * Call this AFTER recording the raw value for telemetry, never before — the
 * distinction between "resolved `none`" and "no scope arrived" is the signal
 * civitai#3983 spent its whole investigation unable to observe, and narrowing
 * erases it.
 */
export function narrowStoreScope(value: unknown): StoreVisibilityScope {
  return isStoreVisibilityScope(value) ? value : 'none';
}
