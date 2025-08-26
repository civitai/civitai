import { NextResponse } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import {
  regionMiddlewareMatcher,
  shouldRunRegionMiddleware,
} from '~/server/middleware/region-middleware-utils';
import { getRegion, isRegionBlocked } from '~/server/utils/region-blocking';

export const regionBlockMiddleware = createMiddleware({
  matcher: regionMiddlewareMatcher,
  shouldRun: (request) => {
    const { nextUrl } = request;
    return shouldRunRegionMiddleware(nextUrl.pathname, true);
  },
  handler: async ({ request }) => {
    // Get country from Cloudflare header
    const region = getRegion(request);

    // Check if the user is from a restricted region
    if (isRegionBlocked(region)) {
      // Redirect to region-blocked page
      return NextResponse.redirect(new URL('/region-blocked', request.url));
    }

    // Allow request to continue for non-restricted regions
    // return NextResponse.next();
  },
});
