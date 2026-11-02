import { NextResponse } from 'next/server';
import { getApiDefaultResponseHeaders } from '~/server/middleware/api-request-policy';
import { createMiddleware } from '~/server/middleware/middleware-utils';

export const apiCacheMiddleware = createMiddleware({
  matcher: ['/api/v1/:path*'],
  handler: async () => {
    const response = NextResponse.next();
    // Default Cache-Control (+ X-Handled-By). `/api/trpc` is outside the proxy matcher; that
    // route applies the same headers itself (`applyApiRequestPolicy`).
    for (const [name, value] of getApiDefaultResponseHeaders()) response.headers.set(name, value);

    return response;
  },
});
