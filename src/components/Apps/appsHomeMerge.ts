import { sanitizeAppChromeName } from '~/components/AppBlocks/appChromeName';
import { getRecentRailTarget, resolveRecentApp } from '~/components/Apps/recentAppsRail';
import type { RecentApp, RecentAppKind } from '~/components/Apps/recentlyOpenedAppsStore';
import type { MyAppRow } from '~/server/services/blocks/my-apps.logic';

/**
 * The `/apps` "My apps" grid: the server-derived apps (`appListings.listMyApps`) merged with
 * this browser's "Recently opened" store for the CURRENT account. Pure and React-free, so the
 * merge rules are covered by the node `unit` project (`__tests__/appsHomeMerge.test.ts`).
 *
 * ── HOW THE TWO SOURCES ARE MATCHED (no second key scheme) ─────────────────────
 * A recents entry is normalised by the store's own `resolveRecentApp`, which yields its
 * `slug` (an on-site entry falls back to `blockId`, which IS the listing slug —
 * `app-listing-mapper` writes `slug: ab.blockId`). A server row carries the listing `slug`.
 * Listing slugs are globally unique across BOTH kinds, so `slug` is the join key. The entry
 * `id` is checked against the row's `listingId` as a fallback: that is the key the store
 * uses for an off-site app and for an on-site listing without a block
 * (`toRecentAppFromListing`). An on-site entry's `id` is the AppBlock id, which a server row
 * does not carry; for those, `slug` is the only match and is sufficient.
 *
 * ── ORDER ──────────────────────────────────────────────────────────────────────
 * Recents first, in their stored order (the store prepends on every open, so that is
 * most-recent-first). Then the server rows the recents did not already place, in the order
 * the server sent them (`lastUsedAt` desc, nulls last, then name).
 *
 * ── A RECENTS ENTRY THE SERVER DOES NOT LIST STILL RENDERS ─────────────────────
 * From its stored name / slug / external URL, with the recents launch target
 * (`getRecentRailTarget`). Its name is publisher-controlled text laundered through
 * localStorage, so it goes through the same sanitizer the app chrome uses for it. It has NO
 * icon: the store never persists one, so the tile resolves it live (`iconFromServer: false`).
 * When an entry DOES match a server row, the server row's fields win — they are fresh and
 * passed the store's media gate for this viewer.
 */

export type AppsHomeTile = {
  /** Stable React key. */
  key: string;
  slug: string;
  name: string;
  category: string | null;
  kind: RecentAppKind;
  /** The server's gated icon; null for a recents-only tile (see `iconFromServer`). */
  iconUrl: string | null;
  /** False ⇒ this tile came from recents alone and must resolve its icon live. */
  iconFromServer: boolean;
  launchHref: string;
  /** True → open in a new tab with `rel="noopener noreferrer"`. */
  external: boolean;
  /** Where the tile came from: the server list, recents alone, or recents matched to a row. */
  source: 'server' | 'recent' | 'both';
  /** The listing id when the server knows it (null for a recents-only tile). */
  listingId: string | null;
  /** The store entry to re-record when this tile launches off-site. */
  recent: RecentApp;
};

function fromServerRow(row: MyAppRow, source: 'server' | 'both'): AppsHomeTile {
  const kind: RecentAppKind = row.kind === 'offsite' ? 'offsite' : 'onsite';
  return {
    key: `listing:${row.listingId}`,
    slug: row.slug,
    name: row.name,
    category: row.category,
    kind,
    iconUrl: row.iconUrl,
    iconFromServer: true,
    launchHref: row.launchHref,
    external: row.external,
    source,
    listingId: row.listingId,
    // The same shape `toRecentAppFromListing` writes for an off-site listing (id = listing id).
    recent: {
      id: row.listingId,
      slug: row.slug,
      kind,
      name: row.name,
      ...(row.external ? { externalUrl: row.launchHref } : {}),
    },
  };
}

export function mergeHomeApps(args: {
  server: readonly MyAppRow[];
  recents: readonly RecentApp[];
  canOpenPage: boolean;
}): AppsHomeTile[] {
  const bySlug = new Map(args.server.map((r) => [r.slug, r]));
  const byListingId = new Map(args.server.map((r) => [r.listingId, r]));
  const placed = new Set<string>(); // listing ids already on the grid
  const seenSlugs = new Set<string>();
  const out: AppsHomeTile[] = [];

  for (const raw of args.recents) {
    const entry = resolveRecentApp(raw);
    if (!entry || seenSlugs.has(entry.slug)) continue;
    seenSlugs.add(entry.slug);

    const row = bySlug.get(entry.slug) ?? byListingId.get(entry.id);
    if (row) {
      if (placed.has(row.listingId)) continue;
      placed.add(row.listingId);
      out.push(fromServerRow(row, 'both'));
      continue;
    }

    const target = getRecentRailTarget(entry, { canOpenPage: args.canOpenPage });
    out.push({
      key: `recent:${entry.slug}`,
      slug: entry.slug,
      name: sanitizeAppChromeName(entry.name) || entry.slug,
      category: null,
      kind: entry.kind,
      iconUrl: null,
      iconFromServer: false,
      launchHref: target.href,
      external: target.external,
      source: 'recent',
      listingId: null,
      recent: raw,
    });
  }

  for (const row of args.server) {
    if (placed.has(row.listingId)) continue;
    placed.add(row.listingId);
    out.push(fromServerRow(row, 'server'));
  }
  return out;
}
