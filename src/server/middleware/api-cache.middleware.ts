import { NextResponse } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import { PRIVATE_CACHE_CONTROL } from '~/shared/constants/cache-control.constants';

export const apiCacheMiddleware = createMiddleware({
  matcher: ['/api/trpc/:path*', '/api/v1/:path*'],
  handler: async () => {
    const response = NextResponse.next();
    response.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL); // Default cache control
    if (process.env.PODNAME) response.headers.set('X-Handled-By', process.env.PODNAME);

    return response;
  },
});
