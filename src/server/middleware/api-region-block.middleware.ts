import { NextResponse } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import { getRegion, isAPIAccessBlocked } from '~/server/utils/region-blocking';

export const apiRegionBlockMiddleware = createMiddleware({
  matcher: ['/api/:path*'],
  handler: async ({ request }) => {
    // Get country from Cloudflare header
    const region = getRegion(request);

    // Check if the user is from a restricted region
    if (isAPIAccessBlocked(region)) {
      // Return 451 status code (Unavailable For Legal Reasons)
      return new NextResponse(
        JSON.stringify({
          error:
            'Access to this service is not available in your region due to legal restrictions.',
          code: 'REGION_BLOCKED',
        }),
        {
          status: 451,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // Allow request to continue for non-restricted regions
    // return NextResponse.next();
  },
});
