/**
 * App Store Listings (W13) — the CACHE TAG names for the listing read path.
 *
 * ── WHY THIS IS ITS OWN LEAF MODULE (imports NOTHING) ────────────────────────────
 * 🔴 THESE MUST NOT LIVE IN `app-listing.service.ts`. Both `app-listings.router.ts`
 * and `blocks.router.ts` deliberately keep the listing/app-surface SERVICES out of
 * their eager import graph and reach them through `await import(…)` at call time —
 * `app-listings.router.ts` states the rule at its own lazy-import site, and
 * `blocks.router.ts` has eight such sites for `user-app-surface.service` alone. The
 * point of that pattern is that a hot router's module graph never drags in the
 * Prisma client (and everything the services pull in behind it).
 *
 * Exporting a plain string constant from a heavy service defeats it silently: the
 * static `import { TAG } from './app-listing.service'` needed to name the tag makes
 * every one of those lazy imports GRAPH-INERT — the module is already loaded, so the
 * `await import(…)` resolves from cache and buys nothing. Nothing errors, and the
 * cost only becomes visible later, when someone adds an import to the service.
 *
 * The precedent, with the measured version of this failure, is
 * `src/server/services/blocks/scope-activity-predicate.ts` — read its header. Same
 * shape here, one step cheaper: this module has no imports at all, not even a type.
 *
 * It also keeps the one-key `vi.mock` factories in the block suites honest: a suite
 * that stubs a mutation service can import the tag names without instantiating the
 * read service.
 */

/**
 * The unified `/apps` store CATALOG page cache (`listAvailableListings`'s keyset
 * query).
 *
 * 🔴 WHAT IS ACTUALLY CACHED IS `{ id, sort_key }` PER ROW — NOTHING ELSE. Read that
 * before deciding whether a new mutation needs a bust, because the intuitive model
 * ("the cache holds the card") is wrong and gives the wrong answer in both directions.
 * The card's projection fields — tagline, description, icon/cover/screenshot URLs, the
 * owner chip, the beta badge — are hydrated by a LIVE query below the cache on every
 * request, so they can never be served stale and a write that touches only those needs
 * no bust.
 *
 * A bust is needed when a write moves something the CACHED STATEMENT itself reads:
 *   · catalog MEMBERSHIP — `al.status` (approved-only), `al.kind`, `al.revision_of_id`,
 *     and `ab.current_version_deployed_at` (the onsite deploy gate);
 *   · a FILTER axis — `al.category`, `al.content_rating` (the maturity gate);
 *   · a `sort_key` input — `al.name`, `al.created_at`, or the `app_listing_metrics`
 *     rollup.
 *
 * The asserted, mechanical form of that rule — every `AppListing` writer either busts
 * or is on an `EXEMPT` list with a reason — lives in
 * `~/server/services/blocks/__tests__/app-listing.catalog-bust-ledger.test.ts`.
 */
export const APP_LISTING_CATALOG_TAG = 'app-listing:catalog';

/**
 * The store-wide Bayesian-prior recommend MEAN (`getGlobalRecommendMean`, 1h).
 *
 * 🔴 PRE-EXISTING TAG STRING — the value is unchanged. It was previously declared
 * as a private literal in TWO places (`app-listing.service.ts`'s
 * `getGlobalRecommendMean` and `app-listing-review.service.ts`'s
 * `bustRecommendMeanCache`), i.e. a producer and its only buster each spelling the
 * same string independently. Both now read it from here, so a rename cannot desync
 * the write side from the bust side.
 */
export const APP_LISTING_RECOMMEND_MEAN_TAG = 'app-listing:recommend-global-mean';
