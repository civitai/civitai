import type { NextRequest } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import { pathToRegexp } from 'path-to-regexp';
import { isProd } from '~/env/other';
import {
  canAccessTestingRoute,
  isNonProdReachableTestingPath,
  resolveRequestHost,
} from '~/server/middleware/testing-route-access';

// The session-based PAGE guards (/moderator, /testing) moved to _app getInitialProps — the edge runtime can't
// resolve the thin hub civ-token to a full user. What's left here is the sessionless /api/testing gate (those
// debug endpoints are non-prod only), so no getToken is needed.
const routeGuards: RouteGuard[] = [];
// Modifying this guard rather than adding a permissive one is forced: the middleware
// below evaluates EVERY matching guard and redirects if ANY of them denies, so a new
// guard can only ever be additive in the deny direction.
addRouteGuard({
  matcher: ['/api/testing/:path*'],
  canAccess: ({ request }) => {
    const pathname = request.nextUrl.pathname;
    const hostname = resolveRequestHost(request);
    const allowed = canAccessTestingRoute({ pathname, hostname, isProduction: isProd });

    // Only fires when a route that is SUPPOSED to be reachable on a non-production
    // host is refused — i.e. the exact state where the gate looks broken. Everything
    // needed to tell which term was false is here, because working that out from
    // outside cost two people an afternoon: a relative `location:` header made curl
    // resolve the redirect against the request URL, which looked like evidence about
    // the app's own view of the host and was not.
    if (!allowed && isNonProdReachableTestingPath(pathname)) {
      console.warn(
        `[route-guards] refused ${pathname} — resolvedHost=${hostname} ` +
          `nextUrlHostname=${request.nextUrl.hostname} ` +
          `host=${request.headers.get('host') ?? '(none)'} ` +
          `xForwardedHost=${request.headers.get('x-forwarded-host') ?? '(none)'}`
      );
    }
    return allowed;
  },
});
//#region Logic

type RouteGuard = {
  matcher: string[];
  isMatch: (pathname: string) => boolean;
  canAccess: (ctx: { request: NextRequest }) => boolean | undefined;
  redirect?: string;
};
function addRouteGuard(routeGuard: Omit<RouteGuard, 'isMatch'>) {
  const regexps = routeGuard.matcher.map((m) => pathToRegexp(m));
  const isMatch = (pathname: string) => regexps.some((r) => r.test(pathname));

  return routeGuards.push({
    ...routeGuard,
    isMatch,
  });
}
export const routeGuardsMiddleware = createMiddleware({
  matcher: routeGuards.flatMap((routeGuard) => routeGuard.matcher),
  handler: async ({ request, redirect }) => {
    const { pathname } = request.nextUrl;

    for (const routeGuard of routeGuards) {
      if (!routeGuard.isMatch(pathname)) continue;
      if (routeGuard.canAccess({ request })) continue;
      return redirect(routeGuard.redirect ?? '/');
    }
  },
});

//#endregion
