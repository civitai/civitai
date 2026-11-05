/**
 * "More in <category>" DISCOVERY-RAIL selection (pure, React-free).
 *
 * Picks what the unified listing detail shows under its discovery rail. Pure so
 * the correctness coverage lands in the node `unit` project — the fast,
 * deterministic suite CI runs on every PR (same rationale as `appListingCardView` /
 * `appListingDetailView` / `recentAppsRail`).
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
 *   4. CAP at `limit` (default `RELATED_LISTINGS_LIMIT`) across both groups.
 *
 * 🔴 THE TWO GROUPS ARE KEPT APART, each under its own heading. The top-up is
 * popular apps from ANY category, so rendering it under "More in <category>" put
 * other categories' apps under a heading that names this one. The same-category
 * group keeps that heading; the top-up renders under {@link POPULAR_RAIL_HEADING}.
 *
 * NO new tRPC procedure and NO server schema change: both inputs come from the
 * EXISTING `appListings.listAvailable` (category filter + sort), which the store
 * grid already uses.
 */

import { marketplaceCategoryLabel } from '~/server/services/blocks/marketplace-categories.constants';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/** Rail cap — one row at the store's widest breakpoint, no "load more". */
export const RELATED_LISTINGS_LIMIT = 6;

/** Heading of the top-up group: popular apps from any category. */
export const POPULAR_RAIL_HEADING = 'Popular apps';

/** One headed group of the rail. */
export type RelatedRailSection = {
  /** `category` = same-category apps; `popular` = the any-category top-up. */
  key: 'category' | 'popular';
  heading: string;
  items: ListingCard[];
};

/**
 * The rail's groups, in render order, with empty groups dropped.
 *
 * The same-category group is headed by {@link relatedRailHeading}; the top-up is headed
 * {@link POPULAR_RAIL_HEADING}, so no app from another category ever renders under a
 * heading that names this one. A listing with no category gets only the popular group.
 */
export function relatedRailSections(opts: {
  /** The listing being viewed — excluded from the result by id. */
  selfId: string;
  /** The viewed listing's category, for the same-category group's heading. */
  category: string | null | undefined;
  /** `listAvailable({ category, sort: 'popular' })` items. Empty when the
   *  listing has no category (the query is not fired). */
  sameCategory?: ListingCard[];
  /** `listAvailable({ sort: 'popular' })` items, used only to top up. */
  popular?: ListingCard[];
  limit?: number;
}): RelatedRailSection[] {
  const limit = opts.limit ?? RELATED_LISTINGS_LIMIT;
  if (limit <= 0) return [];

  let picked = 0;
  const seen = new Set<string>([opts.selfId]);

  // One helper for both groups so the self-exclusion, the de-dup and the shared cap can't
  // be applied to one list and forgotten on the other.
  const take = (items: ListingCard[] | undefined) => {
    const out: ListingCard[] = [];
    for (const item of items ?? []) {
      if (picked >= limit) break;
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      picked++;
    }
    return out;
  };

  const sections: RelatedRailSection[] = [];
  const sameCategory = opts.category ? take(opts.sameCategory) : [];
  if (sameCategory.length > 0) {
    sections.push({
      key: 'category',
      heading: relatedRailHeading(opts.category),
      items: sameCategory,
    });
  }
  const popular = take(opts.popular);
  if (popular.length > 0) {
    sections.push({ key: 'popular', heading: POPULAR_RAIL_HEADING, items: popular });
  }
  return sections;
}

/**
 * Does the caller still need the popular top-up query? True when the
 * same-category pass alone can't fill the rail — so the second query is fired
 * ONLY when it would actually add something (a thin category), not on every
 * detail page view.
 *
 * Mirrors `relatedRailSections`' self-exclusion, so "5 items, one of which is
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

/**
 * The same-category group's HEADING — also the rail's heading while it loads or is empty.
 *
 * 🔴 Lives here, not inline in the component, for this module's stated reason:
 * an expression that renders a user-facing string is testable in the node project once
 * it is pure. It was
 * inline, and that made `RelatedListings` the one call site of
 * `marketplaceCategoryLabel` with no reachable assertion anywhere.
 *
 * Null/unknown handling is the rail's own, and deliberately asymmetric with the
 * chip surfaces: a listing with NO category gets the generic "More apps" rather
 * than a heading with a hole in it, while an UNKNOWN category still names itself
 * (via the shared helper's raw fallback).
 */
export function relatedRailHeading(category: string | null | undefined): string {
  if (!category) return 'More apps';
  return `More in ${marketplaceCategoryLabel(category)}`;
}

/** Shown by anything that names the rail before the rail knows its own first heading. */
export const RELATED_RAIL_NEUTRAL_HEADING = 'Related apps';

/**
 * The heading the rail renders FIRST, or `null` while it is still loading (it does not know
 * yet). One rule for the rail and for anything that links to it, so a link can never promise
 * "More in <category>" and land on "Popular apps": a category with other apps leads with its
 * own group, an app alone in its category (or with none) leads with the popular top-up, and
 * an empty rail shows {@link relatedRailHeading} over its empty note.
 */
export function relatedRailFirstHeading(opts: {
  /** The listing's stored category — the same value the rail's empty-state heading reads. */
  category: string | null | undefined;
  sections: RelatedRailSection[];
  loading: boolean;
}): string | null {
  if (opts.loading) return null;
  return opts.sections[0]?.heading ?? relatedRailHeading(opts.category);
}
