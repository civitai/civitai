import { SessionUser } from 'next-auth';
import { NextRequest } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import { pathToRegexp } from 'path-to-regexp';
import { isProd } from '~/env/other';

const routeGuards: RouteGuard[] = [];
addRouteGuard({
  matcher: ['/moderator/:path*'],
  canAccess: ({ user }) => user?.isModerator,
});
addRouteGuard({
  matcher: ['/testing/:path*'],
  canAccess: ({ user }) => !isProd || user?.isModerator,
});
addRouteGuard({
  matcher: ['/api/testing/:path*'],
  canAccess: () => !isProd,
});
//#region Logic

type RouteGuard = {
  matcher: string[];
  isMatch: (pathname: string) => boolean;
  canAccess: (ctx: { request: NextRequest; user: SessionUser | null }) => boolean | undefined;
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
  useSession: true,
  handler: async ({ user, request, redirect }) => {
    const { pathname } = request.nextUrl;

    for (const routeGuard of routeGuards) {
      if (!routeGuard.isMatch(pathname)) continue;
      if (routeGuard.canAccess({ user, request })) continue;

      // Can't access, redirect to login
      return redirect(routeGuard.redirect ?? `/login?returnUrl=${pathname}`);
    }
  },
});

//#endregion
