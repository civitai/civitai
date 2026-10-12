import { NextResponse } from 'next/server';
import { SYNC_PARAM } from '@civitai/auth/client';
import { createMiddleware } from '~/server/middleware/middleware-utils';

// A `?sync-account=` url is a one-shot login hand-off, not a page. Crawlers found these as
// duplicates of cross-colour pages, and Google indexed some; noindex drops them from the index.
export const syncAccountNoindexMiddleware = createMiddleware({
  matcher: ['/:path*'],
  shouldRun: ({ nextUrl }) =>
    nextUrl.searchParams.has(SYNC_PARAM) && !nextUrl.pathname.startsWith('/api/'),
  handler: async () => {
    const response = NextResponse.next();
    response.headers.set('X-Robots-Tag', 'noindex');
    return response;
  },
});
