import type { NextRequest, NextResponse } from 'next/server';

/**
 * The platform's safe default `Cache-Control` for API responses: usable by the
 * caller's own browser only, and revalidated every time.
 *
 * `apiCacheMiddleware` states it for the prefixes its matcher covers; the
 * endpoint wrappers in `~/server/utils/endpoint-helpers` state the same string
 * for the routes that sit outside those prefixes. Single-sourced here — the
 * module that already defines the middleware contract, is already loaded by the
 * proxy graph, and imports nothing but a `next/server` type — so the two cannot
 * drift and no additional module is pulled into either graph.
 */
export const PRIVATE_CACHE_CONTROL = 'max-age=0, private, no-cache';

export type Middleware = {
  matcher: string[];
  shouldRun?: (request: NextRequest) => boolean;
  handler: (ctx: {
    request: NextRequest;
    redirect: (to: string) => NextResponse;
  }) => Promise<NextResponse | void>;
};

export function createMiddleware(middleware: Middleware) {
  if (!middleware.shouldRun) {
    const matcherBases = middleware.matcher.map((m) => m.split(':')[0]);
    middleware.shouldRun = ({ nextUrl }) =>
      matcherBases.some((m) => nextUrl.pathname.startsWith(m));
  }
  return middleware;
}
