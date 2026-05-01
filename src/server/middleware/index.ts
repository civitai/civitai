import type { SessionUser } from 'next-auth';
import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { civitaiTokenCookieName } from '~/libs/auth';
import { apiCacheMiddleware } from '~/server/middleware/api-cache.middleware';
import { apiRegionBlockMiddleware } from '~/server/middleware/api-region-block.middleware';
import { botDetectionMiddleware } from '~/server/middleware/bot-detection.middleware';
import type { Middleware } from '~/server/middleware/middleware-utils';
import { redirectsMiddleware } from '~/server/middleware/redirects.middleware';
import { regionBlockMiddleware } from '~/server/middleware/region-block.middleware';
import { regionRestrictionMiddleware } from '~/server/middleware/region-restriction.middleware';
import { previewAuthMiddleware } from '~/server/middleware/preview-auth.middleware';
import { routeGuardsMiddleware } from '~/server/middleware/route-guards.middleware';

// NOTE: order matters! Preview auth first, then region blocking, then restriction redirect.
// botDetectionMiddleware is last because it returns `NextResponse.next({ request })`
// to inject a request header for downstream handlers — the runner below merges any
// response-header-only passthroughs (like apiCacheMiddleware's Cache-Control) into
// botDetection's terminal-with-request-mods response so both effects apply.
const middlewares: Middleware[] = [
  previewAuthMiddleware,
  regionBlockMiddleware,
  regionRestrictionMiddleware,
  apiRegionBlockMiddleware,
  routeGuardsMiddleware,
  apiCacheMiddleware,
  redirectsMiddleware,
  botDetectionMiddleware,
];

export const middlewareMatcher = middlewares.flatMap((middleware) => middleware.matcher);

// `NextResponse.next()` sets this internal header to mark the response as a
// "passthrough" (continue to handler) rather than a terminal redirect/rewrite.
const NEXT_PASSTHROUGH_HEADER = 'x-middleware-next';
// `NextResponse.next({ request: { headers } })` sets this internal header (a
// comma-separated list of request-header names that should be overridden). Its
// presence tells us the passthrough is also rewriting request headers — the
// runner returns these immediately rather than merging further.
const REQUEST_OVERRIDE_HEADER = 'x-middleware-override-headers';

function isPassthrough(response: NextResponse): boolean {
  return response.status === 200 && response.headers.get(NEXT_PASSTHROUGH_HEADER) === '1';
}

function mergeAccumulatedHeaders(target: NextResponse, accumulated: Headers | null) {
  if (!accumulated) return;
  accumulated.forEach((value, key) => {
    if (!target.headers.has(key)) target.headers.set(key, value);
  });
}

export async function runMiddlewares(
  request: NextRequest,
  middlewareList: Middleware[] = middlewares
) {
  let user: SessionUser | null = null;
  let hasToken = true;
  const redirect = (to: string) => NextResponse.redirect(new URL(to, request.url));

  // Response headers from passthrough middlewares (e.g. apiCacheMiddleware's
  // Cache-Control). Applied to whichever response is ultimately returned.
  let accumulated: Headers | null = null;

  for (const middleware of middlewareList) {
    if (middleware.shouldRun && !middleware.shouldRun(request)) continue;
    if (middleware.useSession && !user && hasToken) {
      const token = await getToken({
        req: request,
        secret: process.env.NEXTAUTH_SECRET,
        cookieName: civitaiTokenCookieName,
      });
      if (!token) hasToken = false;
      user = token?.user as SessionUser;
    }

    const response = await middleware.handler({
      request,
      user,
      redirect,
    });
    if (!response) continue;

    // Terminal (redirect, rewrite, JSON, etc.) — apply accumulated headers and return.
    if (!isPassthrough(response)) {
      mergeAccumulatedHeaders(response, accumulated);
      return response;
    }

    // Passthrough WITH request-header modifications — this is the canonical
    // "last middleware sets the request header" pattern (botDetectionMiddleware).
    // Apply accumulated response headers and return; subsequent middlewares are
    // skipped, same as the original short-circuit semantics.
    if (response.headers.has(REQUEST_OVERRIDE_HEADER)) {
      mergeAccumulatedHeaders(response, accumulated);
      return response;
    }

    // Passthrough with only response-header changes (e.g. apiCacheMiddleware).
    // Accumulate the non-internal headers and continue the chain.
    if (!accumulated) accumulated = new Headers();
    response.headers.forEach((value, key) => {
      if (!key.startsWith('x-middleware-')) accumulated!.set(key, value);
    });
  }

  // No middleware terminated — return a fresh passthrough with accumulated headers.
  const final = NextResponse.next();
  mergeAccumulatedHeaders(final, accumulated);
  return final;
}
