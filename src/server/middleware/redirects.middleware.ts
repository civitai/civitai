import { pathToRegexp } from 'path-to-regexp';
import { createMiddleware, Middleware } from '~/server/middleware/middleware-utils';

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
