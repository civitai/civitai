/**
 * App store ACQUISITION telemetry: the vocabulary shared by the store UI (which tags the links it
 * renders), the `/apps/run/<slug>` resolver (which records `App_Open`), the `/apps/go/<listingId>`
 * off-site redirect (which records `App_Visit`) and the `AppStore_Action` schema arm.
 *
 * Client-safe: no server imports. Every value here is a CLOSED set or a bounded id, because
 * these all end up in the `details` String column of a ClickHouse table with no TTL — a value a
 * browser can choose must never be free text there, except the one deliberately truncated
 * `query` field documented on `APP_STORE_QUERY_MAX`.
 */

/**
 * Where a launch / visit / store interaction happened.
 *
 * - `store_card`  — a card in the `/apps/store` grid.
 * - `detail`      — the listing detail page (`/apps/store-preview/<slug>`).
 * - `sub_listing` — a sub-listing card (an item an app placed in the store).
 * - `made_with`   — the "Made with <app>" card on a post / image detail page.
 * - `related`     — the related-apps rail under a listing detail.
 * - `direct`      — anything untagged: a pasted or bookmarked link, another site, the run
 *                   chrome's own recents menu. It is the fallback, so an unknown or tampered
 *                   value reads as `direct`, never as a store surface.
 */
export const APP_SURFACES = [
  'store_card',
  'detail',
  'sub_listing',
  'made_with',
  'related',
  'direct',
] as const;
export type AppSurface = (typeof APP_SURFACES)[number];

/** The query parameter a store link carries its surface in (`/apps/run/x?src=store_card`). */
export const APP_SURFACE_PARAM = 'src';

export function isAppSurface(value: unknown): value is AppSurface {
  return typeof value === 'string' && (APP_SURFACES as readonly string[]).includes(value);
}

/**
 * The surface a request names, or `direct`. Only an exact, single, known value counts: an array
 * (a repeated param), an unknown string or nothing all read as `direct`.
 */
export function parseAppSurface(raw: unknown): AppSurface {
  return isAppSurface(raw) ? raw : 'direct';
}

/**
 * The surface of an on-site LAUNCH. An explicit `src` wins; without one, a launch carrying a
 * valid sub-listing id (`?sl=`, validated by the caller) came from a sub-listing card, because
 * that is the only link that builds one.
 */
export function resolveAppOpenSurface(rawSrc: unknown, hasSubListing: boolean): AppSurface {
  const explicit = parseAppSurface(rawSrc);
  if (explicit !== 'direct') return explicit;
  return hasSubListing ? 'sub_listing' : 'direct';
}

/**
 * Tag an IN-SITE href with a surface: any `src` pair already on it is replaced, every other
 * pair keeps its bytes and order, and a hash is preserved. An absolute URL (anything not
 * starting with `/`) is returned unchanged — this never touches an off-site address.
 */
export function withAppSurface(href: string, surface: AppSurface): string {
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const hashAt = href.indexOf('#');
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt < 0 ? '' : beforeHash.slice(queryAt + 1);
  const pairs = query
    .split('&')
    .filter((pair) => pair !== '' && pair.split('=')[0] !== APP_SURFACE_PARAM);
  pairs.push(`${APP_SURFACE_PARAM}=${surface}`);
  return `${path}?${pairs.join('&')}${hash}`;
}

/** Route prefix of the off-site visit redirect. */
export const APP_VISIT_PREFIX = '/apps/go/';

/**
 * The in-site href an off-site listing's "Visit" link points at. The redirect resolves the
 * destination from the listing's STORED URL server-side; nothing in this href names it.
 */
export function appVisitHref(listingId: string, surface: AppSurface): string {
  return `${APP_VISIT_PREFIX}${encodeURIComponent(listingId)}?${APP_SURFACE_PARAM}=${surface}`;
}

/** Bounded listing / sub-listing id: generated ids only, so no text can ride in this field. */
export const APP_STORE_LISTING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The longest DNS name. A longer `Referer` host is not a host and is dropped. */
const REFERRER_HOST_MAX = 253;

/**
 * The HOST of a `Referer` header, lowercased — never the path, query or fragment, which can
 * carry search terms, ids or tokens. `null` for an absent, unparseable, non-http(s) or
 * oversized value.
 */
export function referrerHostOf(referer: unknown): string | null {
  if (typeof referer !== 'string' || !referer) return null;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.length > REFERRER_HOST_MAX) return null;
  return host;
}

/** The `AppStore_Action` steps. */
export const APP_STORE_ACTIONS = ['impression', 'card_click', 'detail_view', 'cta_click'] as const;
export type AppStoreActionKind = (typeof APP_STORE_ACTIONS)[number];

/**
 * The store search box's text is the one free-text field these events carry, so it is cut to
 * this many characters (after trimming) before it is sent, and the server schema rejects
 * anything longer.
 */
export const APP_STORE_QUERY_MAX = 64;

export function truncateStoreQuery(query: string | null | undefined): string | undefined {
  const trimmed = (query ?? '').trim();
  return trimmed ? trimmed.slice(0, APP_STORE_QUERY_MAX) : undefined;
}

/** A grid position bound: no store page renders anywhere near this many cards. */
export const APP_STORE_POSITION_MAX = 10_000;
