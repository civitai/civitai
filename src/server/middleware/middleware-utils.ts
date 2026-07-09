import type { NextRequest, NextResponse } from 'next/server';

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
