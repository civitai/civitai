/**
 * "Recently opened" RAIL view-model (pure, React-free).
 *
 * Turns the tolerant localStorage `RecentApp[]` (see `recentlyOpenedAppsStore`)
 * into the exact list the `/apps` store rail renders, and decides each entry's
 * link target. Extracted as a pure module on purpose: CI does not run the
 * civitai browser-mode (`component`) suites at all (they need Chromium), so the
 * coverage that actually runs on a PR has to live in the node `unit` project —
 * mirroring `appListingCardView` / `appListingDetailView`. (Neither project
 * BLOCKS a merge — the `Unit tests` job is `continue-on-error` — so "runs on
 * every PR" is the whole of the claim.)
 *
 * Three decisions live here:
 *
 * 1. RESOLUTION of a persisted entry (`resolveRecentApp`). The store is
 *    versioned only by what happens to be in a viewer's localStorage, so a read
 *    can return v1 `{id, blockId}` entries written before `slug` existed. Rather
 *    than dropping them (which silently empties a returning viewer's rail) we
 *    resolve them: for an ON-SITE app the AppListing slug IS the AppBlock
 *    `block_id` — single-sourced server-side in
 *    `~/server/services/blocks/app-listing-mapper.ts` (`slug: ab.blockId`) and
 *    already relied on by `getListingCta`, which routes `/apps/run/<card.slug>`
 *    at a route that resolves by `block_id`. An entry with no usable handle at
 *    all returns `null` and is dropped.
 *
 *    🔴 WHAT THIS DOES AND DOES NOT GUARANTEE. Resolution guarantees a
 *    WELL-FORMED target, NOT a resolving one. `/apps/store-preview/<slug>` is an
 *    APPROVED-`AppListing`-only route, so a legacy `{id, blockId}` entry for an
 *    app that has no approved listing row (the listing backfills have not run on
 *    prod) yields a well-formed URL that still 404s. There is deliberately no
 *    cheap fix: proving the target resolves would need a per-entry existence
 *    query (a new server round-trip on every `/apps` render, for a rail that is
 *    pure personalisation), and the alternative — dropping every entry whose
 *    listing we cannot confirm — is exactly the "silently empty a returning
 *    viewer's rail" failure this resolution exists to avoid. So: possible 404 on
 *    a stale legacy entry, accepted, stated here rather than papered over.
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
 *
 * 3. APP-CHROME MENU eligibility (`selectChromeRecentApps`). The in-app chrome's
 *    "Recently run" dropdown has only ONE link shape, `/apps/run/<blockId>`, so
 *    it can't fall back the way (2) does — an entry it can't route is omitted
 *    outright. Same "no dead nav" discipline, different lever.
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

/**
 * A recents entry the app-chrome menu can safely render: on-site AND carrying
 * the `blockId` that builds `/apps/run/<blockId>`.
 */
export type ChromeRecentApp = RecentApp & { blockId: string };

/**
 * The app-chrome ("Civitai Apps" ⋯ menu) "Recently run" list — see
 * `AppBlockChrome` in `~/components/AppBlocks/IframeHost`.
 *
 * That menu has exactly ONE link shape, `/apps/run/<blockId>`, so an entry
 * qualifies only if all three hold:
 *
 *  1. `canOpenPage` — mirrors the run route's OWN predicate, the conjunction
 *     `features.appBlocks && features.appBlocksPages` (NOT just the pages flag:
 *     `appBlocks` is the block-runtime kill-switch, so pages-on/blocks-off is a
 *     reachable state that still 404s). 🔴 THIS IS THE LOAD-BEARING ONE.
 *     `/apps/run/<slug>` 404s fail-closed for a viewer missing either flag
 *     (`src/pages/apps/run/[slug]/[[...path]].tsx`), yet BOTH writers that
 *     feed this menu — the detail page's "Open live" CTA and the legacy
 *     `MarketplaceBody.recordRecent` — record on-site `{hasPage:true}` entries
 *     flag-blind. Without this gate a dark-flag viewer is offered a menu of
 *     guaranteed-404 links. Dark → the whole section is hidden (the menu has no
 *     second link shape to fall back to; the `/apps` rail, which does, keeps
 *     showing the same entries via `getRecentRailTarget`).
 *  2. not the app currently being viewed (nothing to "return" to).
 *  3. on-site with a `blockId`. Off-site listings have no AppBlock at all, so
 *     they would render `/apps/run/undefined`; an off-site entry carrying a
 *     stray `blockId` (hand-edited localStorage) would link to the WRONG app.
 *
 * Pure + exported so the gate is covered by the node `unit` project.
 */
export function selectChromeRecentApps(
  entries: RecentApp[],
  opts: { canOpenPage: boolean; currentAppBlockId?: string; limit: number }
): ChromeRecentApp[] {
  if (!opts.canOpenPage) return [];
  return entries
    .filter(
      (r): r is ChromeRecentApp =>
        r.id !== opts.currentAppBlockId && r.kind !== 'offsite' && !!r.blockId
    )
    .slice(0, opts.limit);
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
 * Build the store entry for a listing the viewer just OPENED FOR REAL.
 *
 * Callers (all of them — keep this list true):
 *  - `AppListingCard`'s new-tab CTA (`cta.external`, i.e. the OFF-SITE "Visit").
 *  - `AppListingDetailBody`'s `PrimaryAction` in `mode: 'visit'`, which is
 *    reached by BOTH kinds: an off-site "Visit", and an ON-SITE page app whose
 *    viewer can't open the in-host route ("Open live" — the raw-origin escape
 *    hatch; see `getDetailPrimaryAction`).
 *
 * What unites them is that each one LEAVES the SPA to the app itself, so the
 * click is the only chance to record the open.
 *
 * 🔴 NOT called for a detail-page VIEW: browsing a listing is not opening it.
 * A second on-site writer exists — the run page (`/apps/run/<slug>`) records
 * itself on mount — which is why the on-site branch below keys on the AppBlock
 * id: the two writers MUST agree on the de-dup key.
 */
export function toRecentAppFromListing(
  card: Pick<ListingCard, 'id' | 'slug' | 'name' | 'iconUrl' | 'kindData'>
): RecentApp {
  const base = {
    slug: card.slug,
    kind: card.kindData.kind,
    name: card.name,
    ...(card.iconUrl ? { iconUrl: card.iconUrl } : {}),
  };
  if (card.kindData.kind === 'onsite') {
    // 🔴 DE-DUP KEY. The store's `id` is the de-dup key, and the OTHER on-site
    // writer — the run page (`/apps/run/<slug>`) — keys on the **AppBlock id**
    // (`recordRecentlyOpenedApp({ id: appBlockId, … })`). Keying on the
    // AppListing id here would make the same app persist as TWO entries (one per
    // writer), so it would appear twice in the rail and its "move to front on
    // re-open" would only ever move one of them. Fall back to the listing id
    // only when the listing has no backing AppBlock, which is also the only case
    // where the run page can never have written the app.
    //
    // On-site: the listing slug IS the AppBlock `block_id` (app-listing-mapper
    // `slug: ab.blockId`), which is exactly what `/apps/run/<slug>` relies on.
    return {
      ...base,
      id: card.kindData.appBlockId ?? card.id,
      blockId: card.slug,
      hasPage: card.kindData.hasPage,
    };
  }
  // Off-site listings have no AppBlock, so the AppListing id IS the only key —
  // and it is the same key the off-site writers use everywhere.
  const externalUrl = safeExternalHref(card.kindData.externalUrl);
  return { ...base, id: card.id, ...(externalUrl ? { externalUrl } : {}) };
}
