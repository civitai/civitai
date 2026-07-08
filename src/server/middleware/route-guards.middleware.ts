import type { NextRequest } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import { pathToRegexp } from 'path-to-regexp';
import { isProd } from '~/env/other';

// The session-based PAGE guards (/moderator, /testing) moved to _app getInitialProps — the edge runtime can't
// resolve the thin hub civ-token to a full user. What's left here is the sessionless /api/testing gate (those
// debug endpoints are non-prod only), so no getToken is needed.
const routeGuards: RouteGuard[] = [];
addRouteGuard({
  matcher: ['/api/testing/:path*'],
  canAccess: () => !isProd,
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
