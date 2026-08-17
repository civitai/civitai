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
  const [, queryString] = urlSource.split('?');
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
 * Re-derive the path params once Next has finished a pop it owned.
 *
 * `resolveLocationChangeState` runs in the popstate handler, where
 * `Router.pathname` is still the route being LEFT, so a pop from `/models/[id]`
 * back to `/images/123` matches no pattern and yields a query with no `imageId`.
 * `BrowserRouterProvider` then commits that query on `routeChangeComplete` —
 * after Next has already repopulated its own `router.query` — and the page reads
 * the empty one and renders its not-found branch. Resolving again against the
 * route now rendered is what puts `imageId` back.
 */
export function resolveRouteChangeState(
  state: BrowserRouterState,
  routePattern?: string
): BrowserRouterState {
  return {
    ...state,
    query: { ...getDynamicRouteParams(routePattern, state.asPath), ...state.query },
  };
}

/**
 * `/images/[imageId]` + `/images/123` → `{ imageId: '123' }`.
 *
 * Self-guarding: a pattern that doesn't match the path yields nothing, so a pop
 * to a *different* route contributes no stale params.
 *
 * Round-tripped through `QS` so params land as the same types the rest of the
 * query does — the matcher yields strings, and consumers pass these straight to
 * tRPC inputs typed as numbers.
 */
function getDynamicRouteParams(routePattern: string | undefined, asPath: string) {
  if (!routePattern?.includes('[')) return {};
  try {
    const params = getRouteMatcher(getRouteRegex(routePattern))(asPath.split('?')[0]);
    return params ? QS.parse(QS.stringify(params)) : {};
  } catch {
    return {};
  }
}
