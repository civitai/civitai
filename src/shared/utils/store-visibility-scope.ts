/**
 * The App-store read VISIBILITY SCOPE — its closed value set, the ONE narrowing
 * rule every consumer applies to an untrusted / possibly-absent scope, and the ONE
 * breadth ORDERING every consumer compares scopes with.
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

/**
 * The listing KINDS a scope admits or excludes. Declared here, in the same
 * dependency-free module as the scope itself, because the scope→kind rule below is
 * the thing both sides of the boundary have to agree on; a server-schema import
 * would put it out of reach of the client gate.
 */
export const STORE_LISTING_KINDS = ['onsite', 'offsite'] as const;

/** One store listing's kind. Structurally identical to the read schema's `ListingKind`. */
export type StoreListingKind = (typeof STORE_LISTING_KINDS)[number];

/**
 * Does this scope admit listings of this KIND?
 *
 * 🔴 THE ONE KIND RULE, shared by the read path, the write path and the client
 * affordance gate. It is the predicate form of the data-layer filter
 * `scope === 'public-external' ? { kind: 'offsite' } : {}` that
 * `listAppListingReviews` / `listAvailableListings` / `getListingDetail` apply — and
 * it exists as a named export precisely so the WRITE path and the UI cannot
 * re-derive a second, disagreeing version of it.
 *
 * That is not hypothetical. The review WRITE gate was keyed on a FLAG
 * (`isAppListingsEnabled`) while the read path had already moved to this scope, so
 * the `app-listings-public-external` cohort could SEE the review affordance on an
 * offsite listing and got `UNAUTHORIZED` on submit. A flag name answers "which
 * cohort"; only the resolved scope answers "which kinds", and reviewability is a
 * question about a kind.
 *
 *   - `full`            — every kind (mods + app-dev-testers): unchanged.
 *   - `public-external` — `offsite` only; `onsite` App Blocks stay invisible, so
 *     they are also un-reviewable. A viewer must never write to a row the same
 *     scope refuses to show them, even by a crafted id.
 *   - `none`            — nothing.
 *
 * Takes an ALREADY-NARROWED scope: run untrusted input through
 * {@link narrowStoreScope} first, so an uninterpretable value is refused rather
 * than falling through this switch.
 */
export function scopeAdmitsListingKind(
  scope: StoreVisibilityScope,
  kind: StoreListingKind
): boolean {
  switch (scope) {
    case 'full':
      return true;
    case 'public-external':
      return kind === 'offsite';
    case 'none':
      return false;
  }
}

/**
 * The scopes RANKED BY BREADTH — a subset lattice, not a preference order:
 *
 *   none  ⊂  public-external  ⊂  full
 *    ∅        kind='offsite'     every kind
 *
 * `none` is the EMPTY set (the caller sees nothing). `public-external` admits
 * exactly the `kind='offsite'` approved listings. `full` admits those AND the
 * `onsite` ones, so it is a STRICT SUPERSET of `public-external`. Every pair is
 * therefore comparable — the set is TOTALLY ordered, which is what makes
 * {@link widerStoreScope} well-defined with no tie-break rule to get wrong.
 *
 * 🔴 THE ORDER IS DECLARED ONCE, HERE, AND EVERY COMPARISON IS DERIVED FROM IT.
 * Not because a chain of `===` tests would be ugly, but because such a chain has to
 * be re-audited at every call site whenever the closed set grows, and one of them
 * will be missed. civitai#4048 was that bug in its simplest form: `scope !== 'none'`
 * standing in for "at least as wide as the public floor", which silently made
 * `public-external` — a NARROWER scope — short-circuit past a grant that would have
 * widened it, so signing in REDUCED what a public endpoint returned.
 *
 * 🔴 The ranks must stay DISTINCT. {@link widerStoreScope} is commutative only
 * because equal ranks imply equal scopes; two scopes sharing a rank would make it
 * return whichever argument came first. Pinned by the suite.
 */
export const STORE_VISIBILITY_SCOPE_RANK: Readonly<Record<StoreVisibilityScope, number>> = {
  none: 0,
  'public-external': 1,
  full: 2,
};

/**
 * How much a scope admits, as a comparable number. Compare RANKS rather than
 * spelling out which scope is which — see the rank map's note above.
 *
 * Takes an already-narrowed scope: run untrusted input through
 * {@link narrowStoreScope} first, so an uninterpretable value is ranked as the
 * empty set rather than falling off the map.
 */
export function storeScopeRank(scope: StoreVisibilityScope): number {
  return STORE_VISIBILITY_SCOPE_RANK[scope];
}

/**
 * The WIDER of two scopes — the LEAST UPPER BOUND on a totally-ordered set, so it
 * is total (defined for all 9 pairs), commutative, associative and idempotent.
 *
 * Use it wherever a floor is being applied to a caller's own scope: it can only
 * ever LIFT, never narrow, which is the property a hand-written conditional keeps
 * losing. It is NOT a union of arbitrary sets — it relies on the subset chain
 * documented on {@link STORE_VISIBILITY_SCOPE_RANK}, and a future scope that is
 * incomparable with the existing three (say, onsite-only) would break that
 * assumption and must not simply be given a rank.
 */
export function widerStoreScope(
  a: StoreVisibilityScope,
  b: StoreVisibilityScope
): StoreVisibilityScope {
  return storeScopeRank(a) >= storeScopeRank(b) ? a : b;
}
