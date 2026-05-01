import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { verifyBot } from '~/server/utils/bot-detection/verify-bot';

/**
 * Paths the bot-detection middleware runs on. Scoped to detail-page surfaces
 * (where we paywall content) plus the tRPC / public REST API routes (so
 * client-side queries fired during hydration also carry the bot header,
 * which `applyDomainFeature` consumes to skip the anonymous PG-only cap).
 * Swap to a single broad matcher (e.g. `'/((?!api|_next|fonts).*)'`)
 * if we ever need bot awareness globally.
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

// Detail-page filter: only entity URLs where the segment after the prefix is
// numeric (e.g. /models/123/slug). Excludes listing pages (/models),
// create/edit flows (/models/create), and static assets that share the
// prefix (/images/android-chrome-192x192.png).
const DETAIL_PAGE_RE =
  /^\/(?:models|images|posts|articles|bounties|challenges|collections)\/\d+(?:\/|$)/;

// API filter: tRPC and public REST routes — client-side queries fired
// during page hydration go through these paths and need the bot header
// for `applyDomainFeature` to skip the anonymous cap.
const API_PATH_RE = /^\/api\/(?:trpc|v1)\//;

const IS_DEV = process.env.NODE_ENV !== 'production';

function getClientIp(request: NextRequest): string | null {
  // Cloudflare sets cf-connecting-ip with the real client IP. Fall back to
  // x-forwarded-for (proxies, curl-spoofed local tests) and then to
  // request.ip (Next's resolved socket address). In dev with a direct
  // browser hit to localhost, none of these are reliably set — fall back
  // to '127.0.0.1' so BOT_TEST_IPS=127.0.0.1 actually matches.
  const detected =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.ip ??
    null;
  if (detected) return detected;
  if (IS_DEV) return '127.0.0.1';
  return null;
}

export const botDetectionMiddleware = createMiddleware({
  matcher: BOT_DETECTION_MATCHER,
  shouldRun: ({ nextUrl }) => {
    const path = nextUrl.pathname;
    return DETAIL_PAGE_RE.test(path) || API_PATH_RE.test(path);
  },
  handler: async ({ request }) => {
    const ua = request.headers.get('user-agent');
    const ip = getClientIp(request);

    const bot = verifyBot(ua, ip);
    if (!bot) return; // pass through unchanged

    const headers = new Headers(request.headers);
    headers.set(VERIFIED_BOT_HEADER, bot);
    return NextResponse.next({ request: { headers } });
  },
});
