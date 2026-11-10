import { sanitizeAppChromeName } from '~/components/AppBlocks/appChromeName';
import { getRecentRailTarget, resolveRecentApp } from '~/components/Apps/recentAppsRail';
import type { RecentApp, RecentAppKind } from '~/components/Apps/recentlyOpenedAppsStore';
import type { MyAppRow } from '~/server/services/blocks/my-apps.logic';
import { withHomeLaunchOrigin } from '~/shared/utils/apps-run-origin';
import { isHiddenFromHome, latestUseMs } from '~/shared/utils/my-apps-hidden';

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
 *
 * ── "REMOVE FROM MY APPS" ──────────────────────────────────────────────────────
 * `hidden` is the viewer's hides (`User.settings.hiddenApps`, slug → ISO time). Every tile —
 * server, recents-only or both — goes through the ONE predicate, `isHiddenFromHome`, with
 * the later of the server row's `lastUsedAt` and the recents entry's `openedAt`: an app
 * removed and not used since stays off the grid; using it again brings it back. The server
 * has already dropped rows hidden by their OWN `lastUsedAt` (before its row cap), so here the
 * rule mostly matters for recents-only tiles and for this page's optimistic removes. An app
 * the server dropped but this browser has since opened renders from its recents entry.
 *
 * A recents entry for a dropped row is judged via `removedSlugsByListingId` — why and how: see
 * `my-apps-hidden.ts`. Hidden tiles are skipped BEFORE they claim a slug, so nothing else shifts.
 *
 * ── LAUNCH ORIGIN ──────────────────────────────────────────────────────────────
 * An in-site run href gets `?from=home` (`withHomeLaunchOrigin`) so the run chrome's way out
 * reads "My apps" → `/apps`. Off-site and store-page hrefs are untouched.
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
    launchHref: withHomeLaunchOrigin(row.launchHref),
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
  /** The viewer's hides, slug → ISO time. Absent → nothing hidden. */
  hidden?: Readonly<Record<string, unknown>>;
  /** `listMyApps`' listing id → slug of each row its hides dropped. Absent → none. */
  removedSlugsByListingId?: Readonly<Record<string, string>>;
}): AppsHomeTile[] {
  const hidden = args.hidden ?? {};
  const removed = args.removedSlugsByListingId ?? {};
  const removedSlug = (listingId: string) =>
    Object.prototype.hasOwnProperty.call(removed, listingId) ? removed[listingId] : undefined;
  // Own-property lookup: a slug like `constructor` must not read Object.prototype.
  const hiddenAt = (slug: string) =>
    Object.prototype.hasOwnProperty.call(hidden, slug) ? hidden[slug] : undefined;
  // The newest open per slug among the recents, so a row matched by a later duplicate still
  // sees it (the store dedupes by id, and an app can in principle sit under two ids).
  const openedAtBySlug = new Map<string, number>();
  for (const raw of args.recents) {
    const entry = resolveRecentApp(raw);
    if (!entry || typeof raw.openedAt !== 'number') continue;
    const prev = openedAtBySlug.get(entry.slug);
    if (prev == null || raw.openedAt > prev) openedAtBySlug.set(entry.slug, raw.openedAt);
  }
  // A tile is hidden under the slug it SHOWS (the one "Remove" writes), judged against every
  // use known for it: the server row's, and this browser's opens under either slug.
  const isHidden = (slug: string, row: MyAppRow | undefined, alsoSlug?: string) =>
    isHiddenFromHome(
      hiddenAt(slug),
      latestUseMs(
        row?.lastUsedAt,
        openedAtBySlug.get(slug),
        alsoSlug ? openedAtBySlug.get(alsoSlug) : undefined
      )
    );

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
    // No served row: a row the server dropped as hidden still claims the entry by listing id.
    const dropped = row ? undefined : removedSlug(entry.id);
    const listingId = row?.listingId ?? (dropped !== undefined ? entry.id : undefined);
    if (listingId !== undefined) {
      if (placed.has(listingId)) continue;
      // Claimed even when hidden, so nothing below re-adds it.
      placed.add(listingId);
    }
    // The slug the tile shows — and the one "Remove" writes, so the one its hide is under.
    const slug = row?.slug ?? dropped ?? entry.slug;
    seenSlugs.add(slug);
    if (isHidden(slug, row, entry.slug)) continue;
    if (row) {
      out.push(fromServerRow(row, 'both'));
      continue;
    }

    const target = getRecentRailTarget({ ...entry, slug }, { canOpenPage: args.canOpenPage });
    out.push({
      key: `recent:${slug}`,
      slug,
      name: sanitizeAppChromeName(entry.name) || slug,
      category: null,
      kind: entry.kind,
      iconUrl: null,
      iconFromServer: false,
      launchHref: withHomeLaunchOrigin(target.href),
      external: target.external,
      source: 'recent',
      listingId: null,
      recent: raw,
    });
  }

  for (const row of args.server) {
    if (placed.has(row.listingId)) continue;
    placed.add(row.listingId);
    if (isHidden(row.slug, row)) continue;
    out.push(fromServerRow(row, 'server'));
  }
  return out;
}

/**
 * Why an EMPTY home is empty — call it only when `mergeHomeApps` returned nothing.
 * `'all-removed'`: the viewer has apps, and every one is off the grid only because of their own
 * "Remove from My apps" hides — the server dropped some (`removedCount`), or the same merge
 * with no hides is non-empty — so "No apps yet" would be false. `'no-apps'`: nothing to show
 * even with every hide ignored.
 */
export function homeEmptyKind(
  args: Parameters<typeof mergeHomeApps>[0] & {
    /** `listMyApps`' count of rows its hides dropped. */
    removedCount?: number;
  }
): 'no-apps' | 'all-removed' {
  const { removedCount = 0, ...merge } = args;
  if (removedCount > 0) return 'all-removed';
  return mergeHomeApps({ ...merge, hidden: {} }).length > 0 ? 'all-removed' : 'no-apps';
}
