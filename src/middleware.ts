// middleware.ts
import type { NextRequest } from 'next/server';
import { middlewareMatcher, runMiddlewares } from '~/server/middleware';

export async function middleware(request: NextRequest) {
  return runMiddlewares(request);
}

// See "Matching Paths" below to learn more
export const config = {
  matcher: [
    '/moderator/:path*',
    '/api/trpc/:path*',
    '/api/v1/:path*',
    '/models/:path*',
    '/user/:path*',
  ],
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};
