import { pathToRegexp } from 'path-to-regexp';
import { NextResponse } from 'next/server';
import type { Middleware } from '~/server/middleware/middleware-utils';
import { createMiddleware } from '~/server/middleware/middleware-utils';

const redirects: Redirect[] = [];

const userNamePathRegexp = pathToRegexp('/user/:username/:path*');
addRedirect({
  matcher: ['/user/:path*'],
  handler: async ({ redirect, request, user }) => {
    const [, username] = userNamePathRegexp.exec(request.nextUrl.pathname) ?? [];
    if (username === 'civitai') return redirect('/404');
    if (username === '@me')
      if (user) return redirect(request.nextUrl.href.replace('/@me', '/' + user.username));
      else return redirect('/login?returnUrl=' + request.nextUrl.pathname);
  },
});

// Bounce .red support links through a .com session-sync trampoline so users
// don't hit the Freshworks SSO callback without a .com cookie. Runs as
// middleware because next.config.mjs redirects evaluate at BUILD time, before
// SERVER_DOMAIN_* env vars are populated in the Docker image.
addRedirect({
  matcher: ['/bugs', '/canny/bugs', '/support-portal'],
  handler: async ({ request }) => {
    const redHost = process.env.SERVER_DOMAIN_RED;
    const primaryHost = process.env.SERVER_DOMAIN_GREEN;
    if (!redHost || !primaryHost) return;
    const host = request.headers.get('host')?.toLowerCase();
    if (host !== redHost.toLowerCase()) return;
    const target = `https://${primaryHost}/support?sync-account=red&sync-redirect=${encodeURIComponent(
      request.nextUrl.pathname
    )}`;
    return NextResponse.redirect(target, 307);
  },
});

//#region Logic
type Redirect = {
  matcher: string[];
  isMatch: (pathname: string) => boolean;
  handler: Middleware['handler'];
};
function addRedirect(redirect: Omit<Redirect, 'isMatch'>) {
  const regexps = redirect.matcher.map((m) => pathToRegexp(m));
  const isMatch = (pathname: string) => regexps.some((r) => r.test(pathname));

  return redirects.push({
    ...redirect,
    isMatch,
  });
}
export const redirectsMiddleware = createMiddleware({
  matcher: redirects.flatMap((redirect) => redirect.matcher),
  useSession: true,
  handler: async (ctx) => {
    const { pathname } = ctx.request.nextUrl;

    for (const redirect of redirects) {
      if (!redirect.isMatch(pathname)) continue;
      const response = redirect.handler(ctx);
      if (response) return response;
    }
  },
});
//#endregion
