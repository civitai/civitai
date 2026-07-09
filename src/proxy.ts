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
    '/((?!api|_next|favicon.ico|region-blocked|fonts|sounds|robots.txt|site.webmanifest).*)', // Removed 'images' exclusion to allow image pages to be processed
    '/moderator/:path*',
    '/testing/:path*',
    '/api/testing/:path*',
    '/api/trpc/:path*',
    '/api/v1/:path*',
    '/images/:path*', // Explicitly include image pages for region blocking
    // '/models/:path*',
    '/user/:path*',
  ],
};
