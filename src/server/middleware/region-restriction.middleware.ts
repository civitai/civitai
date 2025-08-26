import { NextResponse } from 'next/server';
import { env } from '~/env/client';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import {
  regionMiddlewareMatcher,
  shouldRunRegionMiddleware,
} from '~/server/middleware/region-middleware-utils';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';

export const regionRestrictionMiddleware = createMiddleware({
  matcher: regionMiddlewareMatcher,
  shouldRun: (request) => {
    const { nextUrl } = request;
    const pathname = nextUrl.pathname;

    // Don't run if we're already on the green domain
    const host = request.headers.get('host');
    if (host === env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN) {
      return false;
    }

    // Use shared shouldRun logic, but don't exclude region-blocked page
    // since we want to redirect even from the region-blocked page
    return shouldRunRegionMiddleware(pathname, false);
  },
  handler: async ({ request }) => {
    const { nextUrl } = request;

    // Get country from Cloudflare header
    const region = getRegion(request);

    // Check if the user is from a restricted region
    if (isRegionRestricted(region)) {
      // Get the green domain URL
      const greenDomain = env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN;

      if (!greenDomain) {
        console.warn('NEXT_PUBLIC_SERVER_DOMAIN_GREEN is not configured');
        return;
      }

      // Construct the redirect URL with the same path and query parameters
      const redirectUrl = new URL(nextUrl.pathname + nextUrl.search, `https://${greenDomain}`);

      // Add a query parameter to help the frontend detect the redirect
      redirectUrl.searchParams.set('region-redirect', 'true');

      // Create the redirect response
      const response = NextResponse.redirect(redirectUrl);

      // Add the header to indicate this was a region-based redirect
      response.headers.set('x-region-redirect', 'true');
      response.headers.set('x-redirect-reason', 'region-restriction');

      return response;
    }

    // Allow request to continue for non-restricted regions
  },
});
