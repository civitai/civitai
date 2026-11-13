// proxy.ts (Next 16 renamed the `middleware` file convention to `proxy`)
import type { NextRequest } from 'next/server';
import { runMiddlewares } from '~/server/middleware';

export async function proxy(request: NextRequest) {
  return runMiddlewares(request);
}

// Proxy always runs on the Node.js runtime in Next 16 (not the Edge sandbox), so the route guards
// can use full Node APIs — needed for the thin-session migration, where they resolve the user from
// redis/db (`getSessionUser`) instead of reading it from the cookie. Self-hosted, so no infra change.
// See thin-session-token-design.md. Only `matcher` is allowed here now — `runtime` and route-segment
// `api` config are rejected in a Proxy file.
export const config = {
  matcher: [
    '/', // Home page
    // Every page. The lookahead also skips the static files in `public/` that every page load
    // requests — `/workers/*`, the favicons, the touch icons and `/images/<file>.<ext>` — because
    // no middleware does anything for them: the region middlewares skip static file extensions
    // (`shouldRunRegionMiddleware`), and the rest act on `/api/*`, on numeric detail pages, or by
    // adding a noindex header / dropping a client-sent bot header, neither of which means anything
    // on a static file. The `/images` file rule needs the extension: `/images`,
    // `/images/iterate` and `/images/[imageId]` are pages and must still run the proxy.
    '/((?!api|_next|favicon.ico|region-blocked|fonts|sounds|robots.txt|site.webmanifest|workers/|favicon-[a-z]+\\.ico$|apple-touch-icon[^/]*\\.png$|images/.+\\.(?:png|jpe?g|gif|svg|webp|ico)$).*)',
    '/moderator/:path*',
    '/testing/:path*',
    '/api/testing/:path*',
    // `/api/trpc` is deliberately NOT matched: the tRPC route applies the API policy itself
    // (`applyApiRequestPolicy`), so invoking the proxy there would only add per-call overhead.
    // `proxy-trpc-matcher.test.ts` fails if any entry here, including the broad page pattern
    // above, matches a tRPC path.
    '/api/v1/:path*',
    // Viewer page data for static shells: needs the region block the page itself gets.
    '/api/page-data/:path*',
    // No `/images/:path*` entry: the image PAGES are matched by the page pattern above, and an
    // entry here would put the static `/images/<file>` requests back through the proxy.
    // '/models/:path*',
    '/user/:path*',
  ],
};
