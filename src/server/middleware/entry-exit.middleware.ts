import { NextResponse } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';

export const entryExitMiddleware = createMiddleware({
  matcher: ['/:path*'],
  handler: async ({ request }) => {
    console.log('route enter', request.url);
    const response = NextResponse.next();
    console.log('route exit', request.url);
    return response;
  },
});
