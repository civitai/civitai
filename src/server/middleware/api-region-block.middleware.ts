import { NextResponse } from 'next/server';
import { getApiRegionBlock } from '~/server/middleware/api-request-policy';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import { getRegion } from '~/server/utils/region-blocking';

export const apiRegionBlockMiddleware = createMiddleware({
  matcher: ['/api/:path*'],
  handler: async ({ request }) => {
    // Country from the Cloudflare headers; the tRPC route applies the same block itself.
    const block = getApiRegionBlock(getRegion(request));
    if (block) {
      return new NextResponse(block.body, {
        status: block.status,
        headers: { 'Content-Type': block.contentType },
      });
    }

    // Allow request to continue for non-restricted regions
  },
});
