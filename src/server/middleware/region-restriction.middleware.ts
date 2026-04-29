import { NextResponse } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import {
  regionMiddlewareMatcher,
  shouldRunRegionMiddleware,
} from '~/server/middleware/region-middleware-utils';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';

// Edge runtime can't import the env module — read raw process.env here.
function parseGreenHosts(): string[] {
  const primary = process.env.SERVER_DOMAIN_GREEN?.toLowerCase();
  const aliases = (process.env.SERVER_DOMAIN_GREEN_ALIASES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [primary, ...aliases].filter(Boolean) as string[];
}

export const regionRestrictionMiddleware = createMiddleware({
  matcher: regionMiddlewareMatcher,
  shouldRun: (request) => {
    const { nextUrl } = request;
    const pathname = nextUrl.pathname;

    // Don't run if we're already on the green domain (primary or any alias).
    const host = request.headers.get('host')?.toLowerCase();
    if (host && parseGreenHosts().includes(host)) {
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
      // Always redirect to the canonical green primary, never an alias.
      const greenDomain = process.env.SERVER_DOMAIN_GREEN;

      if (!greenDomain) {
        console.warn('SERVER_DOMAIN_GREEN is not configured');
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
