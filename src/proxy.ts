// proxy.ts (Next 16 renamed the `middleware` file convention to `proxy`)
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isGlobalFliptFlagOn } from '~/server/flipt/global-sync';
import { runMiddlewares } from '~/server/middleware';
import { recordTrpcProxySkipped } from '~/server/prom/trpc-proxy-skip.metrics';
import {
  TRPC_PATH_PREFIX,
  TRPC_SKIP_PROXY_MIDDLEWARE_FLAG,
} from '~/server/middleware/api-request-policy';

export async function proxy(request: NextRequest) {
  // The tRPC route applies everything the middlewares do on /api/trpc (region block, default
  // response headers, verified-crawler header) itself — see `applyApiRequestPolicy`. With the
  // flag ON, the proxy hands tRPC straight through; OFF (the default), both apply it, which is
  // idempotent. Once ON has proven out, `/api/trpc/:path*` can leave the matcher below, which is
  // what stops Next invoking the proxy for tRPC at all.
  if (
    request.nextUrl.pathname.startsWith(TRPC_PATH_PREFIX) &&
    isGlobalFliptFlagOn(TRPC_SKIP_PROXY_MIDDLEWARE_FLAG)
  ) {
    recordTrpcProxySkipped();
    return NextResponse.next();
  }
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
    '/((?!api|_next|favicon.ico|region-blocked|fonts|sounds|robots.txt|site.webmanifest).*)', // Removed 'images' exclusion to allow image pages to be processed
    '/moderator/:path*',
    '/testing/:path*',
    '/api/testing/:path*',
    '/api/trpc/:path*',
    '/api/v1/:path*',
    // Viewer page data for static shells: needs the region block the page itself gets.
    '/api/page-data/:path*',
    '/images/:path*', // Explicitly include image pages for region blocking
    // '/models/:path*',
    '/user/:path*',
  ],
};
