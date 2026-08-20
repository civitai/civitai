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
 *  - CAPPED PER KIND: at most `MAX_RECENTS` entries per `kind` are kept
 *    (newest-first). 🔴 A single shared cap let one kind STARVE the other: the
 *    app-chrome "Recently run" menu (`IframeHost`) can only link ON-SITE
 *    entries, so under a flat 8-entry cap a viewer who opened 8 off-site apps
 *    found that menu empty even though they had run on-site apps that week.
 *    Budgeting per kind makes each consumer's supply independent of the other's
 *    traffic. See `capPerKind`.
 *  - DEDUPED: recording an app already in the list MOVES it to the front rather
 *    than adding a duplicate (so the strip shows distinct apps, most-recent
 *    first).
 *  - FAIL-SOFT: a corrupt / unparseable value, a quota error, or a
 *    private-mode throw degrades to "no recents" rather than crashing the page.
 *  - NO DEAD LINKS: an entry survives a read only if it carries a handle that is
 *    navigable FOR ITS KIND — an off-site entry needs `slug` (it has no AppBlock,
 *    so `blockId` can never stand in for one), everything else needs `blockId`
 *    OR `slug`. See `RecentApp` for the shape history and `coerce` for the
 *    acceptance rule; the write path runs the same gate, and the rail's
 *    `resolveRecentApp` applies exactly the same rule on read, so nothing that
 *    is accepted for write can be silently dropped on read.
 *  - ACCOUNT-SCOPED: the stored blob carries the id of the account that wrote
 *    it, and a read by any OTHER viewer returns `[]`. See below.
 *
 * 🔴 ACCOUNT SCOPING — WHY THE OWNER ID IS PERSISTED (#4048)
 *
 * localStorage is per BROWSER PROFILE, not per ACCOUNT, and nothing clears it on
 * a sign-in / sign-out / account switch. Observed in production: a browser
 * profile used first by a moderator session and later signed in as a
 * lower-privileged cohort account rendered a "Recently opened" rail of six apps
 * that account cannot see — the entries carry `name`/`iconUrl`/`slug`
 * themselves, so the rail renders them without fetching anything, and every
 * detail page behind them 404s for that viewer. Not a disclosure (the names were
 * already in that browser), but stale and dead-ended.
 *
 * So a stored blob is an ENVELOPE stamped with its owner:
 * `{ v, ownerId, apps }`. `ownerId` is the numeric user id, or `null` for the
 * SIGNED-OUT viewer — which is that viewer's OWN bucket, not a wildcard: an
 * anonymous blob is not readable by a signed-in viewer and vice versa. A read
 * whose `ownerId` does not match returns `[]`.
 *
 * 🔴 DELIBERATE ONE-TIME RESET. A pre-v4 blob is a BARE `RecentApp[]` with no
 * owner recorded, and that owner is unknowable — the browser holds no evidence
 * of who wrote it. It is therefore DROPPED on read rather than attributed to
 * whoever reads it next, because attributing it IS the bug above. Every existing
 * viewer's rail resets once and repopulates on their next app open; the list is
 * capped at `MAX_RECENTS` per kind and is pure personalisation, so the cost of
 * the reset is one lost convenience shortcut and the cost of guessing is showing
 * one account's history to another. (Same reasoning for a blob whose `v` we do
 * not recognise, e.g. one written by a NEWER build after a rollback.)
 *
 * The owner id is passed IN by each caller (`useCurrentUser()?.id ?? null`) —
 * this module stays React-free and session-free, so it can be unit-tested in the
 * node project and imported from anywhere. `recentsCallSites.test.ts` is the
 * ledger that pins the exact set of modules allowed to call it.
 */

export const RECENTLY_OPENED_APPS_KEY = 'recentlyOpenedApps';

/**
 * Persisted envelope version. Bumped from the implicit "bare array" v3 shape to
 * carry `ownerId`; a blob at any other version is dropped (see the header).
 */
export const RECENTS_ENVELOPE_VERSION = 4;

/**
 * The account a recents blob belongs to: a numeric user id, or `null` for the
 * signed-out viewer.
 *
 * 🔴 `null` is a REAL bucket, not "unknown" and not "any". The anonymous
 * viewer's recents are readable only by the anonymous viewer.
 */
export type RecentsOwnerId = number | null;

/**
 * Max distinct apps retained PER KIND (newest-first).
 *
 * 🔴 PER KIND, not overall. The two consumers do not draw from the same pool:
 * the app-chrome "Recently run" menu shows ON-SITE entries only (it links
 * `/apps/run/<blockId>`, which off-site entries don't have), while the `/apps`
 * rail shows both. Under one shared cap, off-site traffic evicted every on-site
 * entry and silently emptied a pre-existing menu.
 */
export const MAX_RECENTS = 8;

/** Ceiling on the whole stored list (both kinds at their per-kind budget). */
export const MAX_RECENTS_TOTAL = MAX_RECENTS * 2;

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
 *   - v3 adds `{slug?, kind?, hasPage?, externalUrl?}` so an entry can link to
 *     the unified store detail (`/apps/store-preview/<slug>`) and so an OFF-SITE
 *     listing — which has NO `blockId` at all — is representable.
 *   - v4 (this) leaves the ENTRY shape untouched and wraps the LIST in an
 *     owner-stamped envelope (see the module header). v1–v3 wrote a bare array,
 *     which is why the entry tolerance below still matters: a v3 entry inside a
 *     v4 envelope is exactly a v3 entry.
 * The single hard invariant a stored entry must satisfy to survive a read is
 * "it has a handle that is navigable FOR ITS KIND" — `slug` for an off-site
 * entry (it has no AppBlock, so `blockId` cannot stand in), `blockId` OR `slug`
 * otherwise. An entry that fails that could only ever render a dead link, so it
 * is DROPPED (see `coerce`) — on the WRITE path as well as the read, which is
 * why nothing can be persisted that the rail's `resolveRecentApp` then discards.
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
 * ACCEPTANCE RULE (the only structural requirement): a string `id` PLUS a handle
 * that is navigable FOR THAT ENTRY'S KIND.
 *   - `kind: 'offsite'` → a string `slug` is REQUIRED. An off-site listing has no
 *     AppBlock at all, so `blockId` can never stand in for its slug, and every
 *     off-site link (`/apps/store-preview/<slug>`) is slug-keyed.
 *   - anything else (on-site, or a legacy entry with no recorded kind, which is
 *     on-site by construction) → a string `blockId` OR a string `slug`, since for
 *     an on-site app the two are the same value (`app-listing-mapper.ts` →
 *     `slug: ab.blockId`).
 *
 * 🔴 This is deliberately the SAME rule `resolveRecentApp` (`recentAppsRail.ts`)
 * applies on read. They used to differ — this gate accepted `{id, blockId,
 * kind:'offsite'}` and the resolver then dropped it — so a caller could persist
 * an entry that silently vanished on the next read. One rule, both directions.
 *
 * That is what keeps the read tolerant of every previously-shipped shape (`{id,
 * blockId}` from v1/v2 keeps its handle) while still guaranteeing the consumer
 * can always build SOME real link. Every other field is carried through only
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
    // Kind-aware handle requirement — see the ACCEPTANCE RULE above.
    if (coerceKind(src.kind) === 'offsite' ? !hasSlug : !hasBlockId && !hasSlug) continue;

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
 * Trim a newest-first list to `MAX_RECENTS` entries PER KIND, preserving order.
 *
 * A legacy entry with no recorded `kind` is on-site by construction (every
 * writer that existed before the field wrote an AppBlock), so it counts against
 * the on-site budget — the same default `resolveRecentApp` applies.
 */
function capPerKind(entries: RecentApp[]): RecentApp[] {
  const kept: Record<RecentAppKind, number> = { onsite: 0, offsite: 0 };
  const out: RecentApp[] = [];
  for (const entry of entries) {
    const kind: RecentAppKind = entry.kind ?? 'onsite';
    if (kept[kind] >= MAX_RECENTS) continue;
    kept[kind] += 1;
    out.push(entry);
  }
  return out;
}

/**
 * Type-guard a parsed blob down to the v4 owner-stamped envelope, or `null` when
 * it is not one.
 *
 * `null` (i.e. "there are no recents for anybody here") is returned for:
 *  - a BARE ARRAY — the pre-v4 shape. It records no owner and the owner cannot
 *    be recovered, so it is dropped rather than attributed to the current reader
 *    (see the module header: attributing it is the defect this change fixes).
 *  - any other `v`, including a FUTURE one written by a newer build before a
 *    rollback — we cannot know what its fields mean.
 *  - an `ownerId` that is neither `null` nor a finite number: hand-edited, so
 *    "whose is this?" has no answer.
 *
 * A recognised envelope whose `apps` is missing / not an array degrades to an
 * empty list via `coerce`, not to a throw — fail-soft, like everything else here.
 */
function coerceEnvelope(raw: unknown): { ownerId: RecentsOwnerId; apps: RecentApp[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  if (src.v !== RECENTS_ENVELOPE_VERSION) return null;
  const owner = src.ownerId;
  const ownerIsValid = owner === null || (typeof owner === 'number' && Number.isFinite(owner));
  if (!ownerIsValid) return null;
  return { ownerId: owner as RecentsOwnerId, apps: coerce(src.apps) };
}

/**
 * Read `ownerId`'s recents list (newest-first, capped per kind). Returns `[]` on
 * the server, an empty store, a parse error, any localStorage access throw — and,
 * 🔴 crucially, whenever the stored blob belongs to a DIFFERENT viewer (a
 * different account, or the signed-out bucket vs a signed-in one, in either
 * direction).
 *
 * @param ownerId the CURRENT viewer's user id, or `null` if signed out. Callers
 *   pass `useCurrentUser()?.id ?? null`; this module deliberately does not know
 *   how to obtain it (it must stay React-free and server-safe).
 */
export function getRecentlyOpenedApps(ownerId: RecentsOwnerId): RecentApp[] {
  if (!isClient()) return [];
  try {
    const raw = window.localStorage.getItem(RECENTLY_OPENED_APPS_KEY);
    if (!raw) return [];
    const envelope = coerceEnvelope(JSON.parse(raw));
    // Unownable blob (legacy / unknown version / corrupt owner) → no recents.
    if (!envelope) return [];
    // Someone else's recents. `!==` on `number | null` is what makes the
    // anonymous bucket a bucket rather than a wildcard.
    if (envelope.ownerId !== ownerId) return [];
    // Cap on READ too, so a blob written by an older build (flat cap) or by hand
    // can't hand a consumer more than the budget.
    return capPerKind(envelope.apps);
  } catch {
    return [];
  }
}

/**
 * Record that `app` was just opened BY `ownerId`: prepend it (newest-first),
 * de-dup by `id` (an existing entry moves to the front, not duplicated), and cap
 * to `MAX_RECENTS` PER KIND. Returns the new list (or `[]` on the server).
 * Fail-soft: a write throw (quota / private mode) is swallowed.
 *
 * The write is always stamped with `ownerId`, and it starts from what THAT owner
 * can read — so an app opened after an account switch replaces the previous
 * account's blob rather than appending to it. One bucket is persisted at a time;
 * switching back does not restore the earlier account's list, which is the
 * accepted cost of not keeping several accounts' browsing histories side by side
 * in one browser profile.
 */
export function recordRecentlyOpenedApp(app: RecentApp, ownerId: RecentsOwnerId): RecentApp[] {
  if (!isClient()) return [];
  // Run the WRITE through the same acceptance gate the READ applies, so a caller
  // can never persist an entry the reader would silently drop. One gate, two
  // directions — they cannot drift.
  const [clean] = coerce([app]);
  if (!clean) return getRecentlyOpenedApps(ownerId);
  const next = capPerKind([
    clean,
    ...getRecentlyOpenedApps(ownerId).filter((a) => a.id !== clean.id),
  ]);
  try {
    window.localStorage.setItem(
      RECENTLY_OPENED_APPS_KEY,
      JSON.stringify({ v: RECENTS_ENVELOPE_VERSION, ownerId, apps: next })
    );
  } catch {
    // Quota / private-mode / serialization failure — degrade silently; the
    // in-memory `next` is still returned so a caller can update local state.
  }
  return next;
}

/**
 * Clear the recents list (used by tests + a potential "clear" affordance).
 *
 * Owner-AGNOSTIC by design: it removes the whole key, whoever owns it. There is
 * only ever one bucket persisted, and "forget my recents" must work even when
 * what is stored belongs to a previous account.
 */
export function clearRecentlyOpenedApps(): void {
  if (!isClient()) return;
  try {
    window.localStorage.removeItem(RECENTLY_OPENED_APPS_KEY);
  } catch {
    // ignore
  }
}
