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

/**
 * The card fields reconciliation reads. A `Pick` rather than the whole
 * `ListingCard` so a caller can pass anything listing-shaped and so this stays
 * honest about what it consumes.
 */
export type RecentReconcileCard = Pick<
  ListingCard,
  'id' | 'slug' | 'name' | 'iconUrl' | 'kindData'
>;

/**
 * Repair persisted recents from the listings the page has ALREADY loaded.
 *
 * 🔴 THE DEFECT THIS FIXES. `resolveRecentApp` reads `hasPage: entry.hasPage ===
 * true`, so an entry that never RECORDED the field is `false` — and a `false`
 * routes to `/apps/store-preview/<slug>` under an EYE ("read about it") for an
 * app the viewer has been RUNNING. The entries that hit it are the ones
 * `MarketplaceBody.recordRecent` wrote — `{id, blockId, name, iconUrl}`, with no
 * `kind`, no `hasPage` and no `slug`. A real viewer's localStorage was read while
 * diagnosing this: 7 of 8 entries were exactly that shape, so the eye was the
 * rail's DEFAULT rendering, not an edge case.
 *
 * Nothing heals it on its own. `handleOpenRecent` re-persists whatever
 * `resolveRecentApp` produced, so the resolved `false` is written straight back —
 * clicking the tile CANNOT fix it. Only a real visit to `/apps/run/<slug>` ever
 * writes `hasPage: true`.
 *
 * So: the store page already holds the server's answer for every card on screen.
 * Match the persisted entries against it and take the card's values.
 *
 * 🔴 MATCH KEYS — why THREE, and why none of them is `entry.slug` alone. A legacy
 * entry HAS NO `slug`, so a slug-keyed join matches zero rows, upgrades nothing,
 * and ships a change that passes every gate while altering nothing on screen.
 * Each key below is looked up in its OWN namespace, in this order:
 *   1. `entry.id` → `card.kindData.appBlockId`. The on-site de-dup contract: BOTH
 *      on-site writers key `id` on the AppBlock id (see `toRecentAppFromListing`).
 *   2. `entry.id` → `card.id`. The off-site contract — an off-site listing has no
 *      AppBlock, so the AppListing id is its only key.
 *   3. `entry.blockId` (else `entry.slug`) → `card.slug`. For an on-site app the
 *      listing slug IS the AppBlock `block_id` (`app-listing-mapper.ts` →
 *      `slug: ab.blockId`), which is what makes the legacy `{id, blockId}` shape
 *      joinable at all.
 *
 * 🔴 UPGRADE, NEVER DROP. An entry that matches nothing is returned UNTOUCHED.
 * A recents entry is not evidence a listing is missing — it is far more likely on
 * page 2, behind a `kind`/`category` filter, or simply not in the loaded set.
 * Filtering on a failed match would silently empty a returning viewer's rail,
 * which is the exact failure the resolve-don't-drop design exists to avoid.
 *
 * 🔴 A CORRECTION, IN BOTH DIRECTIONS — not a promotion. The card is the server's
 * current truth, so an app that has LOST its page loses the play glyph too. A
 * fill-in-the-blanks variant (`entry.hasPage ?? card.hasPage`) would leave the
 * rail offering `/apps/run/<slug>` — a guaranteed 404 — under an "Open" label.
 * That is why the card's values WIN rather than merely filling gaps, and why a
 * stale `blockId` cannot survive on an entry the card says is off-site (it would
 * point the app-chrome menu at the WRONG app).
 *
 * Built by delegating to `toRecentAppFromListing`, so a reconciled entry is
 * byte-identical to what a fresh open of that card would persist — one rule, one
 * place. Two properties follow and are pinned by tests: `id` is preserved (it is
 * the de-dup key and the rail's ordering handle, so reconciliation must not churn
 * it), and the function is IDEMPOTENT — reconciling a reconciled list is a no-op.
 */
export function reconcileRecentApps(
  entries: RecentApp[],
  cards: RecentReconcileCard[]
): RecentApp[] {
  if (entries.length === 0 || cards.length === 0) return entries;

  const byAppBlockId = new Map<string, RecentReconcileCard>();
  const byListingId = new Map<string, RecentReconcileCard>();
  const bySlug = new Map<string, RecentReconcileCard>();
  for (const card of cards) {
    // First card wins per key — `listAvailable` is already de-duplicated, and a
    // stable rule beats a last-write-wins race across pages.
    if (!byListingId.has(card.id)) byListingId.set(card.id, card);
    if (card.slug && !bySlug.has(card.slug)) bySlug.set(card.slug, card);
    if (card.kindData.kind === 'onsite') {
      const appBlockId = card.kindData.appBlockId;
      if (appBlockId && !byAppBlockId.has(appBlockId)) byAppBlockId.set(appBlockId, card);
    }
  }

  return entries.map((entry) => {
    const handle = entry.blockId ?? entry.slug;
    const card =
      byAppBlockId.get(entry.id) ??
      byListingId.get(entry.id) ??
      (handle ? bySlug.get(handle) : undefined);
    if (!card) return entry;

    const upgraded: RecentApp = { ...toRecentAppFromListing(card), id: entry.id };
    // The card's `iconUrl` is nullable; a previously-recorded icon is better than
    // none, so it is the one field the entry can still contribute.
    if (!upgraded.iconUrl && entry.iconUrl) upgraded.iconUrl = entry.iconUrl;
    return upgraded;
  });
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
 * The three actions a rail tile's icon CTA can represent. Deliberately the SAME
 * vocabulary as the store card's CTA row (`getListingCta` →
 * open / visit / view-details), so one action reads identically on both
 * surfaces: a play glyph always means "run this app here", an external-link
 * glyph always means "this leaves Civitai", an eye always means "read about it".
 */
export type RecentRailAction = 'open' | 'visit' | 'view';

/**
 * Which action the tile's icon button performs, DERIVED from the same target
 * `getRecentRailTarget` picks so the two can never disagree — the icon
 * announcing "Open" while the link goes to the detail page would be a lie in the
 * accessible name, not just a cosmetic mismatch.
 *
 * Additive: `getRecentRailTarget`'s own return shape is untouched (it is pinned
 * by `__tests__/recentAppsRail.test.ts`), so this is a second read of the same
 * decision rather than a contract change.
 */
export function getRecentRailAction(
  entry: ResolvedRecentApp,
  opts: { canOpenPage: boolean }
): { action: RecentRailAction; label: string } {
  const target = getRecentRailTarget(entry, opts);
  if (target.external) return { action: 'visit', label: `Visit ${entry.name ?? entry.slug}` };
  if (target.href.startsWith('/apps/run/'))
    return { action: 'open', label: `Open ${entry.name ?? entry.slug}` };
  return { action: 'view', label: `View details for ${entry.name ?? entry.slug}` };
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
