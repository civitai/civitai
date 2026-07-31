/**
 * "More in <category>" DISCOVERY-RAIL selection (pure, React-free).
 *
 * Picks what the unified listing detail shows under its discovery rail. Pure so
 * the correctness gate lands in the node `unit` project — the browser-mode
 * component suites are REPORT-ONLY / non-blocking (same rationale as
 * `appListingCardView` / `appListingDetailView` / `recentAppsRail`).
 *
 * Selection policy, in order:
 *   1. SELF IS ALWAYS EXCLUDED — from both input lists, by listing id. A
 *      "related" rail that links back to the page you are on is the single most
 *      obvious bug here, so it is enforced once, centrally.
 *   2. SAME CATEGORY FIRST, in the order the server returned (the caller asks
 *      `appListings.listAvailable` for `{ category, sort: 'popular' }`, so that
 *      order is already "most popular in this category").
 *   3. TOP UP WITH POPULAR when the category is thin — several categories hold
 *      only one or two approved listings today, and a rail that renders a single
 *      card reads as broken. Top-ups skip anything already picked.
 *   4. CAP at `limit` (default `RELATED_LISTINGS_LIMIT`).
 *
 * NO new tRPC procedure and NO server schema change: both inputs come from the
 * EXISTING `appListings.listAvailable` (category filter + sort), which the store
 * grid already uses.
 */

import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/** Rail cap — one row at the store's widest breakpoint, no "load more". */
export const RELATED_LISTINGS_LIMIT = 6;

export function selectRelatedListings(opts: {
  /** The listing being viewed — excluded from the result by id. */
  selfId: string;
  /** `listAvailable({ category, sort: 'popular' })` items. Empty when the
   *  listing has no category (the query is not fired). */
  sameCategory?: ListingCard[];
  /** `listAvailable({ sort: 'popular' })` items, used only to top up. */
  popular?: ListingCard[];
  limit?: number;
}): ListingCard[] {
  const limit = opts.limit ?? RELATED_LISTINGS_LIMIT;
  if (limit <= 0) return [];

  const picked: ListingCard[] = [];
  const seen = new Set<string>([opts.selfId]);

  // One helper for both passes so the self-exclusion + de-dup can't be applied
  // to one list and forgotten on the other.
  const take = (items: ListingCard[] | undefined) => {
    for (const item of items ?? []) {
      if (picked.length >= limit) return;
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      picked.push(item);
    }
  };

  take(opts.sameCategory);
  take(opts.popular);
  return picked;
}

/**
 * Does the caller still need the popular top-up query? True when the
 * same-category pass alone can't fill the rail — so the second query is fired
 * ONLY when it would actually add something (a thin category), not on every
 * detail page view.
 *
 * Mirrors `selectRelatedListings`' self-exclusion, so "5 items, one of which is
 * me" correctly counts as 4.
 */
export function needsPopularTopUp(opts: {
  selfId: string;
  sameCategory?: ListingCard[];
  /** True while the category query is still in flight — don't fire the top-up
   *  on an as-yet-empty list, or it fires on EVERY page for one render. */
  categoryLoading?: boolean;
  limit?: number;
}): boolean {
  const limit = opts.limit ?? RELATED_LISTINGS_LIMIT;
  if (opts.categoryLoading) return false;
  const usable = (opts.sameCategory ?? []).filter((c) => c && c.id !== opts.selfId).length;
  return usable < limit;
}

/**
 * Is the rail still loading?
 *
 * 🔴 Feed this `isPending`, NOT react-query v5's `isLoading`. `isLoading` is
 * `isPending && isFetching`, and on the exact render where `wantTopUp` flips
 * true the top-up query has only just been enabled — it is pending but not yet
 * fetching, so `isLoading` reads FALSE for one frame. The rail then renders the
 * thin category result, swaps to a loader, and swaps back to the topped-up list:
 * a visible `2 cards → spinner → 6 cards` flash on every thin-category detail
 * page. `isPending` is true from the moment the query exists with no data, so
 * the loader is continuous.
 *
 * Each query's pending state only counts while that query is actually ENABLED —
 * a disabled react-query query is permanently `pending`, so counting it
 * unconditionally would pin the rail in a loader forever.
 */
export function isRelatedRailLoading(opts: {
  /** True when the category query is enabled (the listing has a known category). */
  hasCategoryFilter: boolean;
  categoryPending: boolean;
  /** True when the popular top-up query is enabled. */
  wantTopUp: boolean;
  popularPending: boolean;
}): boolean {
  return (
    (opts.hasCategoryFilter && opts.categoryPending) || (opts.wantTopUp && opts.popularPending)
  );
}
