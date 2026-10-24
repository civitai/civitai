import { NextResponse } from 'next/server';
import { isBotAwarePath, resolveVerifiedBotHeader } from '~/server/middleware/api-request-policy';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';

/**
 * Paths the bot-detection middleware runs on. Scoped to detail-page surfaces
 * (where we paywall content) plus the tRPC / public REST API routes (so
 * client-side queries fired during hydration also carry the bot header,
 * which `applyDomainFeature` consumes to skip the anonymous PG-only cap).
 * Swap to a single broad matcher (e.g. `'/((?!api|_next|fonts).*)'`)
 * if we ever need bot awareness globally.
 *
 * The decision itself is `resolveVerifiedBotHeader`, which the tRPC route also applies.
 */
export const BOT_DETECTION_MATCHER = [
  '/models/:path*',
  '/images/:path*',
  '/posts/:path*',
  '/articles/:path*',
  '/bounties/:path*',
  '/challenges/:path*',
  '/collections/:path*',
  '/api/trpc/:path*',
  '/api/v1/:path*',
];

export const botDetectionMiddleware = createMiddleware({
  matcher: BOT_DETECTION_MATCHER,
  shouldRun: ({ nextUrl, headers }) =>
    isBotAwarePath(nextUrl.pathname) || headers.has(VERIFIED_BOT_HEADER),
  handler: async ({ request }) => {
    // Only this decision may set the header: a value that arrived with the request is dropped.
    const change = resolveVerifiedBotHeader(request.nextUrl.pathname, (name) =>
      request.headers.get(name)
    );
    if (!change) return; // pass through unchanged

    const headers = new Headers(request.headers);
    if ('set' in change) headers.set(VERIFIED_BOT_HEADER, change.set);
    else headers.delete(VERIFIED_BOT_HEADER);
    return NextResponse.next({ request: { headers } });
  },
});
