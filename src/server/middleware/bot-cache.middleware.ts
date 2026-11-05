import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { botCacheRefusal } from '~/server/bot-cache/bot-cache';
import {
  BOT_CACHE_STATUS_HEADER,
  botCacheCandidatePattern,
  botCacheKey,
  decodeBotCacheBody,
  logBotCacheOriginFailure,
  readBotCacheEntry,
  recordBotCacheOrigin,
} from '~/server/bot-cache/bot-cache-origin';
import { createMiddleware } from '~/server/middleware/middleware-utils';

/** The request in the shape `botCacheRefusal` reads at render (`IncomingMessage`). */
function asRenderRequest(request: NextRequest) {
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers.host ??= request.nextUrl.host;
  const { pathname, search } = request.nextUrl;
  return { method: request.method, url: `${pathname}${search}`, headers };
}

function renderAsMiss() {
  const response = NextResponse.next();
  response.headers.set(BOT_CACHE_STATUS_HEADER, 'miss');
  return response;
}

/**
 * Serves a stored crawler render (`~/server/bot-cache/bot-cache-origin`). The proxy runs before
 * Next resolves the page, so a hit skips the session read, the settings bootstrap,
 * `getServerSideProps` and React. Only for a request `botCacheRefusal` allows: checked against the
 * path's likely pattern before the lookup, so other paths cost none, and against the pattern the
 * entry was rendered as before it is served.
 */
export const botCacheMiddleware = createMiddleware({
  matcher: ['/:path*'],
  shouldRun: ({ nextUrl }) => botCacheCandidatePattern(nextUrl.pathname) !== null,
  handler: async ({ request }) => {
    const candidate = botCacheCandidatePattern(request.nextUrl.pathname);
    if (!candidate) return;
    const req = asRenderRequest(request);
    if (botCacheRefusal(req as never, candidate, { degraded: false }) !== null) return;

    try {
      const { pathname, search } = request.nextUrl;
      const entry = await readBotCacheEntry(botCacheKey(req.headers.host ?? '', pathname, search));
      if (!entry || botCacheRefusal(req as never, entry.pattern, { degraded: false }) !== null) {
        recordBotCacheOrigin('miss', 'lookup');
        return renderAsMiss();
      }
      const html = await decodeBotCacheBody(entry);
      const headers = new Headers(entry.headers);
      headers.delete('set-cookie');
      headers.set(BOT_CACHE_STATUS_HEADER, 'hit');
      recordBotCacheOrigin('hit', 'lookup');
      return new NextResponse(html, { status: 200, headers });
    } catch (error) {
      recordBotCacheOrigin('error', 'lookup');
      logBotCacheOriginFailure('lookup', error);
      return renderAsMiss();
    }
  },
});
