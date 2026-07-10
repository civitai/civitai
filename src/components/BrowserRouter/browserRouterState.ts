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
 * It drops the URL hash (e.g. `#comments`) and any dynamic-route params Next
 * interpolates into `history.state.url` (e.g. `/models/[id]?id=123` → `{id:'123'}`
 * becomes `{}`). This is an accepted degradation on a path that previously
 * HARD-CRASHED — reaching this branch means the populated state was unavailable.
 */
export function resolveLocationChangeState(
  eventState: any,
  historyState: any,
  currentLocation: { pathname: string; search: string }
): BrowserRouterState {
  const locationHref = `${currentLocation.pathname}${currentLocation.search}`;
  const urlSource: string = eventState?.url ?? historyState?.url ?? locationHref;
  const [, queryString] = urlSource.split('?');
  return {
    asPath: eventState?.as ?? locationHref,
    query: QS.parse(queryString) as Record<string, any>,
    state: (historyState?.state ?? {}) as HistoryState,
  };
}
