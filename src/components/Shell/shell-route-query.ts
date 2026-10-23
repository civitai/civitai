import type { NextRouter } from 'next/router';

/**
 * A route-level static shell is rendered with an EMPTY route query (see `_app.getInitialProps`),
 * because one HTML serves every URL of the route. Next's client router starts from that query
 * (`initialData.query` in `next/dist/client/index.js`), while its `asPath` is the real
 * `location` — so on a shell page `router.query` lacks the route's own params until they are
 * restored from the address bar.
 */

/** The params a page pattern requires: `/images/[imageId]` → `['imageId']`. `[[...x]]` is optional. */
export function requiredRouteParams(pattern: string): string[] {
  return [...pattern.matchAll(/\[(\[)?(?:\.\.\.)?([^\]]+)\]\]?/g)]
    .filter((match) => !match[1])
    .map((match) => match[2]!);
}

/** True while the router still holds a shell render's canonical query. */
export function routeQueryPending(router: Pick<NextRouter, 'pathname' | 'query'>): boolean {
  return requiredRouteParams(router.pathname).some((name) => router.query[name] === undefined);
}

type TransitionOptions = NonNullable<Parameters<NextRouter['replace']>[2]>;

/**
 * Restores the route query from `location`, without a data request, a history entry, a scroll or a
 * route-change event: the update Next itself runs after hydrating a page whose query it could not
 * know on the server (`componentDidMount` in `next/dist/client/index.js`, 16.3.1), with the same
 * `_h: 1` option. That option is what this needs over a plain shallow replace
 * (`next/dist/shared/lib/router/router.js` `change()`): a plain one to the current URL is treated
 * as a hash-only change whenever the URL has a hash (`onlyAHashChange`), which never updates the
 * query, and it emits `routeChangeStart`/`routeChangeComplete`, which page-view tracking reads as
 * a navigation. Pinned against the real router by `shell-route-query.test.ts`.
 */
export function syncShellRouteQuery(router: Pick<NextRouter, 'pathname' | 'replace'>) {
  const { pathname, search, hash } = window.location;
  return router.replace(`${router.pathname}${search}`, `${pathname}${search}${hash}`, {
    shallow: true,
    scroll: false,
    // MUTATION M3
  } as TransitionOptions);
}
