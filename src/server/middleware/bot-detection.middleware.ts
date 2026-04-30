import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import { verifyBot } from '~/server/utils/bot-detection/verify-bot';

/**
 * Header name set on the *request* (not response) so downstream handlers
 * (`getServerSideProps`, API routes, AppProvider) can read it.
 */
export const VERIFIED_BOT_HEADER = 'x-civitai-verified-bot';

/**
 * Paths the bot-detection middleware runs on. Scoped to the surfaces where
 * we paywall content, so unrelated routes don't pay the cost. Swap to a
 * single broad matcher (e.g. `'/((?!api|_next|favicon.ico|fonts).*)'`)
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
];

// Match only detail pages where the segment after the prefix is numeric
// (e.g. /models/123/slug, /images/12345). This deliberately excludes:
//   - listing pages (/models, /images)
//   - create/edit flows (/models/create)
//   - static assets that share the prefix (/images/android-chrome-192x192.png,
//     /images/splash/apple-splash-2048-2732.jpg)
// All entity detail routes use numeric `[id]` params, so this is precise.
const DETAIL_PAGE_RE =
  /^\/(?:models|images|posts|articles|bounties|challenges|collections)\/\d+(?:\/|$)/;

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
  shouldRun: ({ nextUrl }) => DETAIL_PAGE_RE.test(nextUrl.pathname),
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
