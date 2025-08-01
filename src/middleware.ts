// middleware.ts
import type { NextRequest } from 'next/server';
import { runMiddlewares } from '~/server/middleware';

export async function middleware(request: NextRequest) {
  return runMiddlewares(request);
}

// See "Matching Paths" below to learn more
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
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};
