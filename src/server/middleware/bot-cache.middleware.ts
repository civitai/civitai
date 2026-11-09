import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type * as BotCacheOrigin from '~/server/bot-cache/bot-cache-origin';
import { botCacheCandidatePattern } from '~/server/bot-cache/bot-cache-routes';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import {
  BOT_CACHE_LOOKUP_FAILED,
  BOT_CACHE_STATUS_HEADER,
} from '~/shared/constants/bot-cache.constants';

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

/** After `BOT_CACHE_LOOKUP_FAILED` the render does not store (`captureBotCacheRender`). */
function renderAs(status: 'miss' | typeof BOT_CACHE_LOOKUP_FAILED) {
  const response = NextResponse.next();
  response.headers.set(BOT_CACHE_STATUS_HEADER, status);
  return response;
}

/**
 * Serves a stored crawler render (`~/server/bot-cache/bot-cache-origin`). The proxy runs before
 * Next resolves the page, so a hit skips the session read, the settings bootstrap,
 * `getServerSideProps` and React. Only for a request `botCacheRefusal` allows: checked against the
 * path's likely pattern before the lookup, so other paths cost none, and against the pattern the
 * entry was rendered as before it is served.
 *
 * The predicate and the cache are imported only for a candidate path, so they (the server env,
 * Flipt, redis) are not part of the proxy's module graph for every other request.
 */
export const botCacheMiddleware = createMiddleware({
  matcher: ['/:path*'],
  shouldRun: ({ nextUrl }) => botCacheCandidatePattern(nextUrl.pathname) !== null,
  handler: async ({ request }) => {
    const candidate = botCacheCandidatePattern(request.nextUrl.pathname);
    if (!candidate) return;
    // Every page request on a candidate path reaches this, signed-in people included, so nothing
    // here may reject: whatever fails, the request renders as if there were no cache.
    let origin: typeof BotCacheOrigin | undefined;
    try {
      const { botCacheRefusal } = await import('~/server/bot-cache/bot-cache');
      const req = asRenderRequest(request);
      if (botCacheRefusal(req as never, candidate, { degraded: false }) !== null) return;

      origin = await import('~/server/bot-cache/bot-cache-origin');
      const { pathname, search } = request.nextUrl;
      const key = origin.botCacheKey(
        req.headers.host ?? '',
        pathname,
        search,
        req.headers['user-agent']
      );
      if (!key) return;
      let entry: BotCacheOrigin.BotCacheEntry | null;
      try {
        entry = await origin.readBotCacheEntry(key);
      } catch (error) {
        origin.recordBotCacheOrigin('error', 'lookup');
        origin.logBotCacheOriginFailure('lookup', error);
        return renderAs(BOT_CACHE_LOOKUP_FAILED);
      }
      if (!entry || botCacheRefusal(req as never, entry.pattern, { degraded: false }) !== null) {
        origin.recordBotCacheOrigin('miss', 'lookup');
        return renderAs('miss');
      }
      const html = await origin.decodeBotCacheBody(entry);
      const headers = new Headers(entry.headers);
      headers.delete('set-cookie');
      headers.set(BOT_CACHE_STATUS_HEADER, 'hit');
      origin.recordBotCacheOrigin('hit', 'lookup');
      return new NextResponse(html, { status: 200, headers });
    } catch (error) {
      if (!origin) return;
      origin.recordBotCacheOrigin('error', 'lookup');
      origin.logBotCacheOriginFailure('lookup', error);
      // Not a failed lookup (no `BOT_CACHE_LOOKUP_FAILED`): the render may store, replacing an
      // entry that did not decode.
      return renderAs('miss');
    }
  },
});
