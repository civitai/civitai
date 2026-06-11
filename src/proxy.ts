// proxy.ts (Next 16 renamed the `middleware` file convention to `proxy`)
import type { NextRequest } from 'next/server';
import { runMiddlewares } from '~/server/middleware';

export async function proxy(request: NextRequest) {
  return runMiddlewares(request);
}

// See "Matching Paths" below to learn more
export const config = {
  // Run the middleware in the Node.js runtime (not the Edge sandbox) so it can use full Node APIs —
  // needed for the thin-session migration, where route guards resolve the user from redis/db
  // (`getSessionUser`) instead of reading it from the cookie. Behavior is unchanged today (the chain
  // still decodes via next-auth `getToken`, which is runtime-agnostic). Self-hosted, so no infra
  // change — the middleware already runs inside the Node server process. See thin-session-token-design.md.
  runtime: 'nodejs',
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
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};
