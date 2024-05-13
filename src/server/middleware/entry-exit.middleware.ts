import { NextResponse } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';

const SLOW_THRESHOLD = 10000;
export const entryExitMiddleware = createMiddleware({
  matcher: ['/:path*'],
  handler: async ({ request }) => {
    console.log('route enter', request.url);
    const start = Date.now();
    const response = NextResponse.next();
    console.log('route exit', request.url);
    const duration = Date.now() - start;
    if (duration > SLOW_THRESHOLD) {
      console.log('route slow', request.url, duration);
    }
    return response;
  },
});
