/**
 * Recently-opened App Blocks — a small, SSR-safe localStorage helper.
 *
 * The marketplace records the app a viewer just opened (block id + slug for
 * re-fetch / display) so the `/apps` page can surface a "Recently opened" strip.
 * This is purely client-side personalisation — it is NEVER read on the server
 * and never mixed into the listing query (it only re-orders / picks from the
 * already-public listing), so it carries no access-control weight.
 *
 * Invariants:
 *  - SSR-SAFE: every `localStorage` access is guarded with `isClient()` (the
 *    `/apps` page renders server-side first — touching `localStorage` at module
 *    scope or during SSR would throw "localStorage is not defined").
 *  - CAPPED: at most `MAX_RECENTS` entries are kept (newest-first).
 *  - DEDUPED: recording an app already in the list MOVES it to the front rather
 *    than adding a duplicate (so the strip shows distinct apps, most-recent
 *    first).
 *  - FAIL-SOFT: a corrupt / unparseable value, a quota error, or a
 *    private-mode throw degrades to "no recents" rather than crashing the page.
 *  - NO DEAD LINKS: an entry survives a read only if it carries a navigable
 *    handle (`blockId` or `slug`). See `RecentApp` for the shape history and
 *    `coerce` for the acceptance rule; the write path runs the same gate.
 */

export const RECENTLY_OPENED_APPS_KEY = 'recentlyOpenedApps';

/** Max distinct apps retained in the recents list (newest-first). */
export const MAX_RECENTS = 8;

/** Store kind — mirrors `ListingKind` but is deliberately its OWN union so the
 *  localStorage schema doesn't import the server DTO module into the store. */
export type RecentAppKind = 'onsite' | 'offsite';

/**
 * One recorded recently-opened app.
 *
 * `id` is the stable de-dup key (the AppBlock id for an on-site app, the
 * AppListing id for an off-site one — both opaque, and never mixed within one
 * kind).
 *
 * 🔴 EVERY OTHER FIELD IS OPTIONAL, and the read is tolerant by design. This
 * store is persisted in a viewer's localStorage, so entries written by ANY
 * previously-shipped version are still in the wild and must keep parsing:
 *   - v1 wrote `{id, blockId}`.
 *   - v2 added `{name?, iconUrl?}`.
 *   - v3 (this) adds `{slug?, kind?, hasPage?, externalUrl?}` so an entry can
 *     link to the unified store detail (`/apps/store-preview/<slug>`) and so an
 *     OFF-SITE listing — which has NO `blockId` at all — is representable.
 * The single hard invariant a stored entry must satisfy to survive a read is
 * "it has a navigable handle": `blockId` OR `slug`. An entry with neither could
 * only ever render a dead link, so it is DROPPED (see `coerce`).
 *
 * Field meanings:
 *  - `blockId` — the AppBlock slug (`block_id`); backs `/apps/run/<blockId>` and
 *    `<blockId>.civit.ai`. ON-SITE ONLY; absent for an off-site listing.
 *  - `slug`    — the AppListing slug; backs `/apps/store-preview/<slug>`. For an
 *    ON-SITE listing this equals `blockId` (single-sourced in
 *    `app-listing-mapper.ts` → `slug: ab.blockId`), which is what lets a legacy
 *    `{id, blockId}` entry be RESOLVED rather than dropped — see
 *    `resolveRecentApp` in `recentAppsRail.ts`.
 *  - `kind`    — 'onsite' | 'offsite'; picks the link/CTA shape.
 *  - `hasPage` — on-site only: the app declares a full-page surface, so
 *    `/apps/run/<blockId>` is a real route (behind `appBlocksPages`).
 *  - `externalUrl` — off-site only: the https destination actually visited.
 *  - `name` / `iconUrl` — display enrichments so a consumer can render the entry
 *    WITHOUT re-fetching the listing.
 */
export type RecentApp = {
  id: string;
  blockId?: string;
  slug?: string;
  kind?: RecentAppKind;
  hasPage?: boolean;
  externalUrl?: string;
  name?: string;
  iconUrl?: string;
};

function isClient(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** A stored `kind` value is only carried through when it is one of the two we
 *  understand — a hand-edited / future value degrades to "unknown kind" rather
 *  than flowing into the link logic as an unhandled discriminant. */
function coerceKind(value: unknown): RecentAppKind | undefined {
  return value === 'onsite' || value === 'offsite' ? value : undefined;
}

/**
 * Type-guard a parsed JSON blob down to a clean `RecentApp[]` (drops any
 * malformed entries). Defensive against hand-edited / legacy localStorage.
 *
 * ACCEPTANCE RULE (the only structural requirement): a string `id` PLUS at
 * least one navigable handle — a string `blockId` or a string `slug`. That is
 * what makes the read tolerant of every previously-shipped shape (`{id,
 * blockId}` from v1/v2 keeps its handle) while still guaranteeing the consumer
 * can always build SOME real link — an entry with no handle is dropped instead
 * of being rendered as a dead one. Every other field is carried through only
 * when present AND correctly typed, so a partially-corrupt entry degrades to
 * "less enrichment", never a crash.
 */
function coerce(raw: unknown): RecentApp[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentApp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const src = item as Record<string, unknown>;
    if (typeof src.id !== 'string') continue;
    const hasBlockId = typeof src.blockId === 'string' && src.blockId.length > 0;
    const hasSlug = typeof src.slug === 'string' && src.slug.length > 0;
    // No navigable handle → the entry could only ever render a dead link.
    if (!hasBlockId && !hasSlug) continue;

    const entry: RecentApp = { id: src.id };
    if (hasBlockId) entry.blockId = src.blockId as string;
    if (hasSlug) entry.slug = src.slug as string;
    const kind = coerceKind(src.kind);
    if (kind) entry.kind = kind;
    if (typeof src.hasPage === 'boolean') entry.hasPage = src.hasPage;
    if (typeof src.externalUrl === 'string') entry.externalUrl = src.externalUrl;
    if (typeof src.name === 'string') entry.name = src.name;
    if (typeof src.iconUrl === 'string') entry.iconUrl = src.iconUrl;
    out.push(entry);
  }
  return out;
}

/**
 * Read the recents list (newest-first, capped). Returns `[]` on the server, an
 * empty store, a parse error, or any localStorage access throw.
 */
export function getRecentlyOpenedApps(): RecentApp[] {
  if (!isClient()) return [];
  try {
    const raw = window.localStorage.getItem(RECENTLY_OPENED_APPS_KEY);
    if (!raw) return [];
    return coerce(JSON.parse(raw)).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/**
 * Record that `app` was just opened: prepend it (newest-first), de-dup by `id`
 * (an existing entry moves to the front, not duplicated), and cap to
 * `MAX_RECENTS`. Returns the new list (or `[]` on the server). Fail-soft: a
 * write throw (quota / private mode) is swallowed.
 */
export function recordRecentlyOpenedApp(app: RecentApp): RecentApp[] {
  if (!isClient()) return [];
  // Run the WRITE through the same acceptance gate the READ applies, so a caller
  // can never persist an entry the reader would silently drop (an entry with no
  // `blockId`/`slug` handle). One gate, two directions — they cannot drift.
  const [clean] = coerce([app]);
  if (!clean) return getRecentlyOpenedApps();
  const next = [clean, ...getRecentlyOpenedApps().filter((a) => a.id !== clean.id)].slice(
    0,
    MAX_RECENTS
  );
  try {
    window.localStorage.setItem(RECENTLY_OPENED_APPS_KEY, JSON.stringify(next));
  } catch {
    // Quota / private-mode / serialization failure — degrade silently; the
    // in-memory `next` is still returned so a caller can update local state.
  }
  return next;
}

/** Clear the recents list (used by tests + a potential "clear" affordance). */
export function clearRecentlyOpenedApps(): void {
  if (!isClient()) return;
  try {
    window.localStorage.removeItem(RECENTLY_OPENED_APPS_KEY);
  } catch {
    // ignore
  }
}
