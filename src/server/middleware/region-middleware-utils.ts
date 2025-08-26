/**
 * Shared utilities for region-based middlewares
 */

// Define exclusion patterns shared between region middlewares
export const excludedPaths = ['/api', '/_next', '/fonts', '/sounds'];

export const excludedFiles = ['favicon.ico', 'robots.txt', 'site.webmanifest'];

export const staticFileExtensions = [
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

// Common matcher pattern for region middlewares
export const regionMiddlewareMatcher = [
  '/((?!api|_next|favicon.ico|region-blocked|fonts|sounds|robots.txt|site.webmanifest).*)',
];

/**
 * Shared shouldRun logic for region-based middlewares
 * @param pathname - The pathname from nextUrl
 * @param excludeRegionBlocked - Whether to exclude the region-blocked page (default: true)
 * @returns Whether the middleware should run
 */
export function shouldRunRegionMiddleware(pathname: string, excludeRegionBlocked = true): boolean {
  // Don't run on specific excluded paths
  if (excludedPaths.some((path) => pathname.startsWith(path))) {
    return false;
  }

  // Don't run on the region-blocked page itself (configurable)
  if (excludeRegionBlocked && pathname === '/region-blocked') {
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
}
