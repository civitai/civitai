import { APPS_HOME_HREF, APPS_STORE_HREF } from '~/shared/constants/apps-routes.constants';

/**
 * Where a full-page app run (`/apps/run/<slug>`) was launched from, so the run chrome's way
 * out leads back there: launched from the "My apps" home → "My apps" (`/apps`); from anywhere
 * else (the store, a direct link, the chrome's own "Recently run" menu, unknown) →
 * "Marketplace" (`/apps/store`).
 *
 * THE SIGNAL is a query parameter the home tile puts on its launch href (`?from=home`). The
 * run page reads it in `getServerSideProps` and hands it down as a prop, so the server render
 * and the first client render agree (no hydration flip) and it survives a reload. It never
 * reaches the embedded app: the iframe `src` is built server-side from the AppBlock alone,
 * and the only part of the parent URL the host forwards is the `[[...path]]` sub-path (into
 * BLOCK_INIT's `context.subPath`), never the query string.
 *
 * The parameter is left in the visible URL rather than stripped with a `router.replace`:
 * stripping would re-render the route with a changed `router.query` under the block host for
 * no functional gain, and keeping it is what makes a reload consistent.
 *
 * RELOAD AFTER IN-APP NAVIGATION. The embedded app moves its own sub-path with a NAVIGATE
 * message, which the host turns into a shallow `router.push` of an href built from the app's
 * path. That href is passed through `withRunLaunchOrigin` with the run's launch origin
 * (`resolveNavigateRequest`), so a home-launched run keeps `?from=home` in the visible URL
 * after the app navigates, and a reload or a copied link still reads "My apps". The host's
 * value WINS over any `from` the app put in its own path: the app never sees the parent's
 * query (BLOCK_INIT and ROUTE_CHANGED carry the sub-path only), so a `from` it supplies is
 * not a round-trip of ours, and an app must not be able to relabel the chrome's way out.
 */

export const APPS_RUN_FROM_PARAM = 'from';
export const APPS_RUN_FROM_HOME = 'home';

export type AppsRunOrigin = 'home' | 'store';

/** Only the exact value `home` counts; anything else (absent, repeated, garbage) is the store. */
export function parseAppsRunOrigin(raw: unknown): AppsRunOrigin {
  return raw === APPS_RUN_FROM_HOME ? 'home' : 'store';
}

const RUN_PREFIX = '/apps/run/';

/** True when one raw `key[=value]` query pair names the `from` parameter (as the server parses it). */
function isFromPair(pair: string): boolean {
  const eq = pair.indexOf('=');
  const rawKey = (eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' ');
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    // A malformed escape leaves a `%` in any lenient decode, so it can never read as `from`.
    return false;
  }
  return key === APPS_RUN_FROM_PARAM;
}

/**
 * Make an in-site run href carry exactly the given launch origin: every `from` pair already on
 * it is dropped (however it is spelled — `fr%6Fm=` decodes to `from` on the server), then
 * `from=home` is appended when the origin is `home`. So `store` yields NO `from` at all and
 * `home` yields exactly one. Every other query pair (e.g. the store's `sl` sub-listing id) keeps
 * its original bytes and order, and a hash is preserved.
 *
 * Anything that is not a `/apps/run/…` path (an off-site URL, a store detail page, another site
 * page) is returned unchanged: only the run chrome reads the signal.
 */
export function withRunLaunchOrigin(href: string, origin: AppsRunOrigin): string {
  if (!href.startsWith(RUN_PREFIX)) return href;
  const hashAt = href.indexOf('#');
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt < 0 ? '' : beforeHash.slice(queryAt + 1);
  const pairs = query.split('&').filter((pair) => pair !== '' && !isFromPair(pair));
  if (origin === 'home') pairs.push(`${APPS_RUN_FROM_PARAM}=${APPS_RUN_FROM_HOME}`);
  return pairs.length ? `${path}?${pairs.join('&')}${hash}` : `${path}${hash}`;
}

/** The home tile's launch href: `withRunLaunchOrigin(href, 'home')`. */
export function withHomeLaunchOrigin(href: string): string {
  return withRunLaunchOrigin(href, 'home');
}

/** The run chrome's way out — the breadcrumb's first crumb and the mobile back chevron. */
export function appsRunBackTarget(origin: AppsRunOrigin): {
  href: typeof APPS_HOME_HREF | typeof APPS_STORE_HREF;
  label: 'My apps' | 'Marketplace';
} {
  return origin === 'home'
    ? { href: APPS_HOME_HREF, label: 'My apps' }
    : { href: APPS_STORE_HREF, label: 'Marketplace' };
}
