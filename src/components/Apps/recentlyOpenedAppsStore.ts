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
 */

export const RECENTLY_OPENED_APPS_KEY = 'recentlyOpenedApps';

/** Max distinct apps retained in the recents list (newest-first). */
export const MAX_RECENTS = 8;

/** One recorded recently-opened app. `id` is the app block id (the stable key
 *  used for de-dup); `blockId` is the human/slug handle kept for display +
 *  re-resolution against the listing. */
export type RecentApp = {
  id: string;
  blockId: string;
};

function isClient(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Type-guard a parsed JSON blob down to a clean `RecentApp[]` (drops any
 *  malformed entries). Defensive against hand-edited / legacy localStorage. */
function coerce(raw: unknown): RecentApp[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentApp[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as RecentApp).id === 'string' &&
      typeof (item as RecentApp).blockId === 'string'
    ) {
      out.push({ id: (item as RecentApp).id, blockId: (item as RecentApp).blockId });
    }
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
  const next = [app, ...getRecentlyOpenedApps().filter((a) => a.id !== app.id)].slice(
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
