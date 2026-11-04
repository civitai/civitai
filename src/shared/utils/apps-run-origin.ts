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
 */

export const APPS_RUN_FROM_PARAM = 'from';
export const APPS_RUN_FROM_HOME = 'home';

export type AppsRunOrigin = 'home' | 'store';

/** Only the exact value `home` counts; anything else (absent, repeated, garbage) is the store. */
export function parseAppsRunOrigin(raw: unknown): AppsRunOrigin {
  return raw === APPS_RUN_FROM_HOME ? 'home' : 'store';
}

const RUN_PREFIX = '/apps/run/';

/**
 * Stamp the home-launch signal on an in-site run href. Anything that is not a `/apps/run/…`
 * path (an off-site URL, a store detail page) is returned unchanged: only the run chrome
 * reads the signal. Existing query parameters (e.g. the store's `sl` sub-listing id) and a
 * hash are preserved.
 */
export function withHomeLaunchOrigin(href: string): string {
  if (!href.startsWith(RUN_PREFIX)) return href;
  const hashAt = href.indexOf('#');
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const params = new URLSearchParams(queryAt < 0 ? '' : beforeHash.slice(queryAt + 1));
  params.set(APPS_RUN_FROM_PARAM, APPS_RUN_FROM_HOME);
  return `${path}?${params.toString()}${hash}`;
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
