/**
 * Shared utilities for region-based middlewares
 */

// Define exclusion patterns shared between region middlewares
export const excludedPaths = ['/api', '/_next', '/fonts', '/sounds'];

export const excludedFiles = ['favicon.ico', 'robots.txt', 'site.webmanifest'];

// Static asset file extensions — paths ending in these are skipped by the
// region middlewares. Case-insensitive on purpose: the proxy matcher's exclusions
// are case-sensitive, so a case variant of a static path (`/IMAGES/X.PNG`,
// `/Site.Webmanifest`) still reaches these middlewares, and its `next.config.mjs`
// static-asset Cache-Control rule (which matches without case) would ride on a
// region redirect. Compiled once at module init.
const STATIC_FILE_EXT_RE =
  /\.(ico|png|jpg|jpeg|gif|svg|webp|webmanifest|css|js|woff2?|ttf|eot|xml|json)$/i;

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
  if (STATIC_FILE_EXT_RE.test(pathname)) return false;

  return true;
}
