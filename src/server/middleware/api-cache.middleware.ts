import { NextResponse } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';

export const apiCacheMiddleware = createMiddleware({
  matcher: ['/api/trpc/:path*', '/api/v1/:path*'],
  handler: async () => {
    const response = NextResponse.next();
    response.headers.set('Cache-Control', 'max-age=0, private, no-cache'); // Default cache control
    if (process.env.PODNAME) response.headers.set('X-Handled-By', process.env.PODNAME);

    return response;
  },
});
