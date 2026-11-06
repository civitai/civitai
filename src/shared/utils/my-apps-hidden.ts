/**
 * "Remove from My apps" — THE rule for whether a hidden app is shown on the `/apps` home.
 * Hides live in `User.settings.hiddenApps` (`{ [slug]: ISO hiddenAt }`), and
 *
 *     shown  ⇔  lastUsed > hiddenAt
 *
 * so using an app again brings it back with no separate "unhide". The server applies it to
 * each row's `lastUsedAt` before the My apps row cap (`buildMyApps`), so a removed app takes
 * no slot; the client merge (`mergeHomeApps`) applies it again with this browser's
 * recently-opened `openedAt` folded in. Opening a page app's run route clears its hide
 * server-side (`openingClearsHide`), so a reopened app comes back with its server row.
 *
 * Keyed by SLUG, not listing id: a recents-only tile has no listing id, and the slug is the
 * merge's join key. A renamed slug orphans its entry, which fails OPEN (the app shows again).
 *
 * Why dropping a row server-side is safe for the merge: the dropped row can no longer claim
 * this browser's recents entry for it, and an off-site entry may be stored under an OLDER slug
 * than the row's (the hide is written under the row's). So `buildMyApps` also returns each
 * dropped row's listing id → slug (`removedSlugsByListingId`), and the merge judges an entry
 * with that id exactly as it judges a matched one — under the row's slug, with the entry's
 * opens under either slug — rather than under its stale slug, which no hide names. It shows
 * only when opened after the hide, and under the row's slug, so removing it again writes the
 * hide the server reads.
 *
 * KNOWN LIMITATIONS:
 *  - when the run page's clear does not happen (its read fails open to "not hidden", or the
 *    write fails), the server keeps dropping the row: the app still shows, as a recents-only
 *    tile in the browser that opened it, and elsewhere only after its next server-side use;
 *  - an off-site app's server `lastUsedAt` is its OAuth CONSENT time and it has no run route,
 *    so a hidden off-site app returns on other devices only on re-consent (in the browser
 *    that opened it from the store or a tile, as a recents-only tile);
 *  - `hiddenAt` is server time and `openedAt` this browser's clock, so a client clock behind
 *    the server can keep a just-reopened app hidden until its next use.
 */

/** The settings key the hides live under. */
export const HIDDEN_APPS_SETTINGS_KEY = 'hiddenApps';

/** The most hides kept per user; past it the OLDEST are dropped (they show again). */
export const HIDDEN_APPS_MAX = 500;

/** Listing slugs are at most 64 characters (`getAppListingDetailSchema`). */
export const HIDDEN_APP_SLUG_MAX = 64;

export type HiddenApps = Record<string, string>;

/** Epoch ms of a stored `hiddenAt`, or null when it is not a parseable date string. */
function hiddenAtMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * THE predicate. True when the app must stay off the home: it was hidden, and it has not been
 * used strictly after the hide. A missing or unparseable `hiddenAt` never hides (fail open:
 * a corrupt entry must not make an app vanish). A `lastUsedMs` of null means "no known use",
 * which keeps a valid hide in force.
 */
export function isHiddenFromHome(hiddenAt: unknown, lastUsedMs: number | null): boolean {
  const hidden = hiddenAtMs(hiddenAt);
  if (hidden == null) return false;
  if (lastUsedMs == null || !Number.isFinite(lastUsedMs)) return true;
  return !(lastUsedMs > hidden);
}

/**
 * "Opening clears the hide" — the cross-device COMPLEMENT of `isHiddenFromHome`, not a second
 * copy of it. `isHiddenFromHome` decides what the home SHOWS from the uses it can see; this
 * decides when the run page must ERASE the hide, because opening a page app is a use the
 * server would otherwise never record. Opening is a use at "now", which is after every stored
 * hide, so ANY entry for the slug in the (sanitised) map is cleared, whatever its time. True
 * only when there is an entry to clear, so the common open writes nothing. (An unparseable
 * stored entry is dropped by `sanitizeHiddenApps` before this sees it — it is inert anyway.)
 */
export function openingClearsHide(hidden: HiddenApps, slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(hidden, slug);
}

/**
 * The latest of some optional instants, as epoch ms (null when none is known). Accepts a
 * Date, epoch ms, or a date string (a serialised `lastUsedAt`); anything unparseable is
 * ignored rather than treated as a use.
 */
export function latestUseMs(
  ...candidates: Array<Date | number | string | null | undefined>
): number | null {
  let best: number | null = null;
  for (const c of candidates) {
    const ms = c instanceof Date ? c.getTime() : typeof c === 'string' ? Date.parse(c) : c;
    if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
    if (best == null || ms > best) best = ms;
  }
  return best;
}

/**
 * A stored `hiddenApps` value narrowed to well-formed entries: a plain object whose keys are
 * non-empty slugs within the length bound and whose values parse as dates (re-emitted as
 * canonical ISO). Anything else — an array, a scalar, a garbage entry — is dropped, so a
 * hand-edited or corrupt blob degrades to "fewer hides", never to a crash or a hidden app.
 */
export function sanitizeHiddenApps(raw: unknown): HiddenApps {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: HiddenApps = {};
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!slug || slug.length > HIDDEN_APP_SLUG_MAX) continue;
    const ms = hiddenAtMs(value);
    if (ms == null) continue;
    out[slug] = new Date(ms).toISOString();
  }
  return out;
}

/**
 * The slugs to drop so at most `max` hides remain: the OLDEST first (an unparseable value
 * counts as oldest, so garbage goes before any real hide), ties broken by slug so the choice
 * is deterministic. Empty when the map is within the cap.
 */
export function hiddenAppsOverflow(raw: unknown, max: number = HIDDEN_APPS_MAX): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const entries = Object.entries(raw as Record<string, unknown>);
  const excess = entries.length - max;
  if (excess <= 0) return [];
  return entries
    .map(([slug, value]) => ({ slug, at: hiddenAtMs(value) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => a.at - b.at || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, excess)
    .map((e) => e.slug);
}
