/**
 * "Recently opened" RAIL view-model (pure, React-free).
 *
 * Turns the tolerant localStorage `RecentApp[]` (see `recentlyOpenedAppsStore`)
 * into the exact list the `/apps` store rail renders, and decides each entry's
 * link target. Extracted as a pure module on purpose: the civitai browser-mode
 * (`component`) suites are REPORT-ONLY / non-blocking, so the real gate for this
 * behaviour lives in the node `unit` project — mirroring `appListingCardView` /
 * `appListingDetailView`.
 *
 * Two decisions live here:
 *
 * 1. RESOLUTION of a persisted entry (`resolveRecentApp`). The store is
 *    versioned only by what happens to be in a viewer's localStorage, so a read
 *    can return v1 `{id, blockId}` entries written before `slug` existed. Rather
 *    than dropping them (which silently empties a returning viewer's rail) we
 *    resolve them: for an ON-SITE app the AppListing slug IS the AppBlock
 *    `block_id` — single-sourced server-side in
 *    `~/server/services/blocks/app-listing-mapper.ts` (`slug: ab.blockId`) and
 *    already relied on by `getListingCta`, which routes `/apps/run/<card.slug>`
 *    at a route that resolves by `block_id`. An entry we CANNOT resolve to a
 *    working target returns `null` and is dropped — never rendered as a dead
 *    link.
 *
 * 2. TARGET selection (`getRecentRailTarget`). Same "no dead nav" discipline the
 *    card/detail view-models use:
 *      - off-site  → the https-guarded external destination (new tab). No
 *        `externalUrl` → the unified detail instead.
 *      - on-site + `hasPage` + `canOpenPage` → `/apps/run/<blockId>` (re-open the
 *        app — the point of a recents rail).
 *      - anything else (no page, page but `appBlocksPages` dark, or a legacy
 *        entry whose `hasPage` we never recorded) → `/apps/store-preview/<slug>`,
 *        the unified detail. Always a real target.
 */

import { getListingDetailHref, safeExternalHref } from '~/components/Apps/appListingCardView';
import type { RecentApp, RecentAppKind } from '~/components/Apps/recentlyOpenedAppsStore';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/** How many recents the `/apps` rail shows. Deliberately below the store's
 *  `MAX_RECENTS` (8) so the rail is one tidy row, not a second grid. */
export const RECENT_RAIL_LIMIT = 6;

/**
 * A recents entry that has been proven renderable: it has a `slug` (so the
 * unified detail is always reachable) and a definite `kind`.
 */
export type ResolvedRecentApp = {
  id: string;
  slug: string;
  kind: RecentAppKind;
  /** On-site only — backs the `/apps/run/<blockId>` re-open link. */
  blockId?: string;
  hasPage: boolean;
  externalUrl?: string;
  name?: string;
  iconUrl?: string;
};

/**
 * Normalise ONE persisted entry, resolving the legacy shapes. Returns `null`
 * when the entry cannot be given a working target (→ the caller drops it).
 */
export function resolveRecentApp(entry: RecentApp): ResolvedRecentApp | null {
  // An entry with no recorded kind predates the kind field, and every writer
  // that existed then wrote an ON-SITE app block — so default to 'onsite'.
  const kind: RecentAppKind = entry.kind ?? 'onsite';

  if (kind === 'offsite') {
    // Off-site listings have no AppBlock, so `blockId` can NEVER stand in for
    // the slug here. No slug → nothing to link to → drop.
    if (!entry.slug) return null;
    const externalUrl = safeExternalHref(entry.externalUrl) ?? undefined;
    return {
      id: entry.id,
      slug: entry.slug,
      kind,
      hasPage: false,
      ...(externalUrl ? { externalUrl } : {}),
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
    };
  }

  // On-site: `slug === blockId` (see the module docstring), so a legacy
  // `{id, blockId}` entry resolves instead of being dropped.
  const slug = entry.slug ?? entry.blockId;
  if (!slug) return null;
  const blockId = entry.blockId ?? entry.slug;
  return {
    id: entry.id,
    slug,
    kind,
    ...(blockId ? { blockId } : {}),
    // A legacy entry never recorded `hasPage`. Treat "unknown" as FALSE so the
    // rail routes it to the always-valid detail rather than to an
    // `/apps/run/<slug>` route that 404s for a model-slot app.
    hasPage: entry.hasPage === true,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
  };
}

/**
 * The rail's entries: resolve each persisted entry, drop the unresolvable ones,
 * de-dup by id (newest-first wins — the store already prepends), and cap.
 *
 * The store already dedups + caps on write; this re-applies both because the
 * blob is user-writable localStorage and because the rail's cap
 * (`RECENT_RAIL_LIMIT`) is tighter than the store's `MAX_RECENTS`.
 */
export function selectRecentRailEntries(
  entries: RecentApp[],
  opts: { limit?: number } = {}
): ResolvedRecentApp[] {
  const limit = opts.limit ?? RECENT_RAIL_LIMIT;
  const seen = new Set<string>();
  const out: ResolvedRecentApp[] = [];
  for (const entry of entries) {
    const resolved = resolveRecentApp(entry);
    if (!resolved || seen.has(resolved.id)) continue;
    seen.add(resolved.id);
    out.push(resolved);
    if (out.length >= limit) break;
  }
  return out;
}

export type RecentRailTarget = {
  href: string;
  /** True → render as a new-tab anchor (rel="noopener noreferrer"). */
  external: boolean;
};

/**
 * Where one rail entry navigates. Always returns a real target (see the module
 * docstring for the policy).
 */
export function getRecentRailTarget(
  entry: ResolvedRecentApp,
  opts: { canOpenPage: boolean }
): RecentRailTarget {
  if (entry.kind === 'offsite') {
    const href = safeExternalHref(entry.externalUrl);
    if (href) return { href, external: true };
    return { href: getListingDetailHref(entry.slug), external: false };
  }
  if (entry.hasPage && opts.canOpenPage && entry.blockId) {
    return { href: `/apps/run/${encodeURIComponent(entry.blockId)}`, external: false };
  }
  return { href: getListingDetailHref(entry.slug), external: false };
}

/**
 * Build the store entry for a listing the viewer just OPENED FOR REAL — used by
 * the off-site "Visit" CTA (card + detail), which is the moment an off-site app
 * is actually opened (there is no on-platform route to record it later).
 *
 * 🔴 NOT called for a detail-page VIEW: browsing a listing is not opening it.
 * The on-site counterpart is recorded by the run page itself
 * (`/apps/run/<slug>`), i.e. only once the app really launched.
 */
export function toRecentAppFromListing(
  card: Pick<ListingCard, 'id' | 'slug' | 'name' | 'iconUrl' | 'kindData'>
): RecentApp {
  const base: RecentApp = {
    id: card.id,
    slug: card.slug,
    kind: card.kindData.kind,
    name: card.name,
    ...(card.iconUrl ? { iconUrl: card.iconUrl } : {}),
  };
  if (card.kindData.kind === 'onsite') {
    // On-site: the listing slug IS the AppBlock `block_id` (app-listing-mapper
    // `slug: ab.blockId`), which is exactly what `/apps/run/<slug>` relies on.
    return { ...base, blockId: card.slug, hasPage: card.kindData.hasPage };
  }
  const externalUrl = safeExternalHref(card.kindData.externalUrl);
  return { ...base, ...(externalUrl ? { externalUrl } : {}) };
}
