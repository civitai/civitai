import { NextResponse } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';
import { getRegion, isRegionBlocked } from '~/server/utils/region-blocking';

// Define exclusion patterns
const excludedPaths = ['/api', '/_next', '/fonts', '/sounds'];
const excludedFiles = ['favicon.ico', 'robots.txt', 'site.webmanifest'];
const staticFileExtensions = [
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.css',
  '.js',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.xml',
  '.json',
];

export const regionBlockMiddleware = createMiddleware({
  matcher: [
    '/((?!api|_next|favicon.ico|region-blocked|fonts|sounds|robots.txt|site.webmanifest).*)',
  ],
  shouldRun: ({ nextUrl }) => {
    const pathname = nextUrl.pathname;

    // Don't run on specific excluded paths
    if (excludedPaths.some((path) => pathname.startsWith(path))) {
      return false;
    }

    // Don't run on the region-blocked page itself
    if (pathname === '/region-blocked') {
      return false;
    }

    // Don't run on specific excluded files
    if (excludedFiles.some((file) => pathname === `/${file}`)) {
      return false;
    }

    // Don't run on any static files (including static images)
    if (pathname.includes('.') && staticFileExtensions.some((ext) => pathname.endsWith(ext))) {
      return false;
    }

    return true;
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
