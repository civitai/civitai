/**
 * "Remove from My apps" — the viewer's explicit hides on the `/apps` home, and THE rule that
 * decides whether a hidden app is shown again. Pure and React-free, shared by the client
 * merge (`mergeHomeApps`) and the server writer (`my-apps-hidden.service.ts`).
 *
 * Membership of the home stays IMPLICIT (grants, purchases, recent use, OAuth consent, and
 * this browser's recently-opened list). A hide does not delete any of that; it records WHEN
 * the viewer removed the app, per listing slug, in `User.settings.hiddenApps`
 * (`{ [slug]: ISO datetime }`). An app is hidden while it has not been used since:
 *
 *     shown  ⇔  lastUsed > hiddenAt
 *
 * where `lastUsed` is the later of the server row's `lastUsedAt` and this browser's
 * recently-opened `openedAt` for the app. Using the app again — opening it in-site, a new
 * grant, purchase or scope invocation — therefore brings it back without a separate "unhide".
 *
 * Keyed by SLUG, not listing id: the slug is the one handle every tile has (a recents-only
 * tile has no listing id — an on-site recents entry's `id` is the AppBlock id), and it is
 * already the merge's join key. A renamed slug orphans its entry, which fails OPEN (the app
 * shows again); the cap below bounds orphans.
 *
 * CROSS-DEVICE: opening a page app's run route (`/apps/run/<slug>`) while it is hidden CLEARS
 * the hide server-side (`openingClearsHide` below), so every device shows it again — not
 * only the browser whose recently-opened `openedAt` moved. An app that never invokes a scope
 * moves nothing else server-side, so without this a hide made on one device outlived a
 * reopen on another.
 *
 * KNOWN LIMITATIONS (by design, not solved here):
 *  - an off-site OAuth app's server `lastUsedAt` is its CONSENT time and it has no run route,
 *    so a hidden off-site app returns on other devices only on re-consent; on THIS browser it
 *    also returns when opened from a tracked in-site path (the store's "Visit" or a home tile,
 *    which record a recently-opened entry);
 *  - `hiddenAt` is server time and `openedAt` is this browser's clock, so a client clock
 *    running behind the server can keep a just-reopened app hidden until its next use.
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
