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
 * reaches the embedded app: the iframe `src` is built server-side from the AppBlock alone, and
 * the query string the host forwards (BLOCK_INIT / ROUTE_CHANGED `search`) has every
 * {@link HOST_OWNED_RUN_PARAMS} pair stripped first, `from` included.
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
 * value WINS over any `from` the app put in its own path: the app never sees the host's own
 * pairs (they are stripped from the `search` it is sent), so a `from` it supplies is not a
 * round-trip of ours, and an app must not be able to relabel the chrome's way out.
 */

export const APPS_RUN_FROM_PARAM = 'from';
export const APPS_RUN_FROM_HOME = 'home';

/**
 * 🔴 THE ONE LIST of query parameters the HOST owns on a `/apps/run/…` URL. Every pair named
 * here is stripped from the `search` an embedded app is sent (BLOCK_INIT / ROUTE_CHANGED) and
 * from every SHARE_LINK URL (`stripHostOwnedRunParams`, used by
 * `components/AppBlocks/deepLinkLogic.ts`), so host attribution never leaks into an app or
 * travels in a link someone else opens.
 *
 *  - `from` — the launch origin ({@link APPS_RUN_FROM_PARAM});
 *  - `sl`   — the store sub-listing id the run page reads (`isAppSubListingId(ctx.query.sl)`);
 *  - `src`  — the store surface a launch came from (`APP_SURFACE_PARAM`, app-store-telemetry).
 *
 * A DENYLIST, not an allowlist, because everything else in the query belongs to the APP: its
 * own deep-link state (`?take=3`) is arbitrary and cannot be enumerated here. The cost is the
 * hazard this comment exists for: a NEW host-owned parameter leaks by default until it is
 * added. Spelled as literals rather than imported, so this module stays import-free of the
 * store telemetry; `src/components/AppBlocks/__tests__/deepLinkLogic.test.ts` pins that `from`
 * and `src` here equal the exported constants.
 */
export const HOST_OWNED_RUN_PARAMS: readonly string[] = ['from', 'sl', 'src'];

export type AppsRunOrigin = 'home' | 'store';

/** Only the exact value `home` counts; anything else (absent, repeated, garbage) is the store. */
export function parseAppsRunOrigin(raw: unknown): AppsRunOrigin {
  return raw === APPS_RUN_FROM_HOME ? 'home' : 'store';
}

const RUN_PREFIX = '/apps/run/';

/** The decoded key of one raw `key[=value]` query pair (as the server parses it), or `null`. */
function pairKey(pair: string): string | null {
  const eq = pair.indexOf('=');
  const rawKey = (eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' ');
  try {
    return decodeURIComponent(rawKey);
  } catch {
    // A malformed escape leaves a `%` in any lenient decode, so it can never read as a name.
    return null;
  }
}

/** True when one raw `key[=value]` query pair names the `from` parameter (as the server parses it). */
function isFromPair(pair: string): boolean {
  return pairKey(pair) === APPS_RUN_FROM_PARAM;
}

/**
 * Remove every {@link HOST_OWNED_RUN_PARAMS} pair (however its key is spelled) from an href or
 * path. Every other pair keeps its bytes and order; the path and hash are untouched. Unlike
 * {@link withRunLaunchOrigin} it applies to any path, not only `/apps/run/…`.
 */
export function stripHostOwnedRunParams(href: string): string {
  const hashAt = href.indexOf('#');
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  if (queryAt < 0) return href;
  const path = beforeHash.slice(0, queryAt);
  const pairs = beforeHash
    .slice(queryAt + 1)
    .split('&')
    .filter((pair) => {
      if (pair === '') return false;
      const key = pairKey(pair);
      return key === null || !HOST_OWNED_RUN_PARAMS.includes(key);
    });
  return pairs.length ? `${path}?${pairs.join('&')}${hash}` : `${path}${hash}`;
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
