import { getRouteMatcher } from 'next/dist/shared/lib/router/utils/route-matcher';
import { getRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex';
import { QS } from '~/utils/qs';

export type HistoryState = {
  prev?: { asPath: string };
} & Record<string, any>;

export type BrowserRouterState = {
  asPath: string;
  query: Record<string, any>;
  state?: HistoryState;
};

/**
 * Build the browser-router state from a (possibly `null`) popstate/history state.
 *
 * Safari (and iOS WebViews) deliver a `null` `history.state` / popstate
 * `e.state` on some back/forward navigations and back-forward-cache restores,
 * where Chrome keeps the Next.js-populated state object. Reading `.as` / `.url`
 * / `.state` off that null threw `TypeError: null is not an object` in the
 * popstate handler and broke client-side back navigation for iOS users.
 *
 * When the state object is missing those fields we fall back to the *current
 * location* (which popstate has already updated) so the router still reflects
 * the real URL rather than crashing or going blank:
 *  - `asPath`  ← `eventState.as`  else `location.pathname + location.search`
 *  - `query`   ← parsed from `eventState.url` / `history.state.url` else location
 *  - `state`   ← `history.state.state` else `{}`
 *
 * NOTE: the `location` fallback is pathname-level, NOT fully asPath-equivalent.
 * It drops the URL hash (e.g. `#comments`). This is an accepted degradation on a
 * path that previously HARD-CRASHED — reaching this branch means the populated
 * state was unavailable.
 *
 * `routePattern` is the Next route of the page currently rendered
 * (`Router.pathname`, e.g. `/images/[imageId]`). Params that live in the *path*
 * appear in no query string anywhere, so without it a pop back onto a dynamic
 * route yields a query with no `imageId` and the page renders its not-found
 * branch. Next normally re-interpolates them into `router.query`, but it never
 * sees this navigation: `RoutedDialogProvider.beforePopState` returns false for a
 * pop out of a routed dialog, so this function is the only thing that runs.
 */
export function resolveLocationChangeState(
  eventState: any,
  historyState: any,
  currentLocation: { pathname: string; search: string },
  routePattern?: string
): BrowserRouterState {
  const locationHref = `${currentLocation.pathname}${currentLocation.search}`;
  const urlSource: string = eventState?.url ?? historyState?.url ?? locationHref;
  const [, search] = urlSource.split('?');
  const queryString = search?.split('#')[0];
  const asPath = eventState?.as ?? locationHref;
  return {
    asPath,
    query: {
      ...getDynamicRouteParams(routePattern, asPath),
      ...(QS.parse(queryString) as Record<string, any>),
    },
    state: (historyState?.state ?? {}) as HistoryState,
  };
}

/**
 * The state to publish once Next has finished a navigation it owned.
 *
 * `resolveLocationChangeState` reconstructs `asPath`/`query` from the history
 * entry because on a pop Next declines (a routed dialog) nothing else will. When
 * Next DOES own the pop, that reconstruction is both unnecessary and wrong: it
 * runs in the popstate handler, where `Router.pathname` is still the route being
 * LEFT, so the path params come out of the outgoing pattern — empty for
 * `/models/[id]` → `/images/123`, which is what left `/images/[imageId]` with no
 * `imageId` and rendered its not-found branch. Take Next's own query instead; it
 * has already re-interpolated the params for the route it just rendered.
 *
 * Only `state` (the history entry's own payload) still comes from the pop —
 * Next does not carry it.
 */
export function resolveRouteChangeState(
  router: { asPath: string; query: Record<string, any> },
  state: HistoryState
): BrowserRouterState {
  return {
    asPath: router.asPath,
    query: QS.parse(QS.stringify(router.query)) as Record<string, any>,
    state,
  };
}

/**
 * `/images/[imageId]` + `/images/123` → `{ imageId: '123' }`.
 *
 * A pattern that doesn't match the path yields nothing. That is not a guarantee
 * of the right param on the `resolveLocationChangeState` path: the pattern there
 * is the OUTGOING route, and two patterns can both match one path
 * (`/comics/[id]/[[...slug]]` reads `/comics/project/55/chapter/2` as
 * `id: 'project'`). Only `resolveRouteChangeState`, which takes Next's own
 * query, is free of that.
 *
 * Round-tripped through `QS` so params land as the same types the rest of the
 * query does — the matcher yields strings, and consumers pass these straight to
 * tRPC inputs typed as numbers.
 *
 * The hash is stripped along with the query string: `eventState.as` keeps it, and
 * `/images/123#comments` otherwise matches with `imageId: '123#comments'`.
 */
function getDynamicRouteParams(routePattern: string | undefined, asPath: string) {
  if (!routePattern?.includes('[')) return {};
  try {
    const params = getRouteMatcher(getRouteRegex(routePattern))(asPath.split(/[?#]/)[0]);
    return params ? QS.parse(QS.stringify(params)) : {};
  } catch {
    return {};
  }
}
