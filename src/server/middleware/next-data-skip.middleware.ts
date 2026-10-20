import fs from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createMiddleware } from '~/server/middleware/middleware-utils';

// A `/_next/data/…json` request for a page with no getServerSideProps/getStaticProps renders the full
// HTML, which the client discards (it runs getInitialProps itself). Answer with the `{}` +
// `x-middleware-skip` response Next sends for an `x-middleware-prefetch` (base-server.js).

function routesManifestPath() {
  return path.resolve(process.cwd(), process.env.NEXT_DIST_DIR || '.next', 'routes-manifest.json');
}

type ManifestRoute = { page: string };
type RoutesManifest = {
  staticRoutes?: ManifestRoute[];
  dataRoutes?: ManifestRoute[];
  rewrites?: ManifestRoute[] | { beforeFiles?: unknown[] };
  i18n?: unknown;
};

// Next leaves `/_app`, `/_document` and `/_error` out of `staticRoutes`, but lists static API routes.
const ERROR_PAGES = new Set(['/404', '/500']);
const isApiRoute = (page: string) => page === '/api' || page.startsWith('/api/');

function disabled(manifestPath: string, reason: string) {
  console.warn(`[next-data-skip] ${reason} (${manifestPath}); data requests will render as pages`);
  return new Set<string>();
}

/**
 * Static pages with no data-fetching method: `dataRoutes` lists exactly the pages with
 * getServerSideProps or getStaticProps. Never throws; any doubt returns an empty set, so every
 * request renders as before. An empty `dataRoutes` is doubt: only a build fills it, and this app has
 * such pages. A `beforeFiles` rewrite runs after the proxy and could send a static path elsewhere.
 * Without `i18n` the proxy cannot tell another build's data request from this one's (see below).
 */
function readPropslessStaticPages(manifestPath: string): Set<string> {
  let manifest: RoutesManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RoutesManifest;
  } catch (e) {
    return disabled(manifestPath, `cannot read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const dataPages = new Set((manifest.dataRoutes ?? []).map((route) => route.page));
  if (dataPages.size === 0) return disabled(manifestPath, 'no data routes');
  if (!manifest.i18n) return disabled(manifestPath, 'no i18n config');
  const rewrites = manifest.rewrites;
  if (rewrites && !Array.isArray(rewrites) && (rewrites.beforeFiles?.length ?? 0) > 0) {
    return disabled(manifestPath, 'beforeFiles rewrites present');
  }
  return new Set(
    (manifest.staticRoutes ?? [])
      .map((route) => route.page)
      .filter((page) => !dataPages.has(page) && !ERROR_PAGES.has(page) && !isApiRoute(page))
  );
}

let propslessPages: Set<string> | undefined;

function isPropslessPage(pathname: string) {
  // Under `next dev` the dist dir's manifest has no data routes or is left from an earlier build.
  if (process.env.NODE_ENV !== 'production') return false;
  propslessPages ??= readPropslessStaticPages(routesManifestPath());
  return propslessPages.has(pathname);
}

// Next's server sets `x-nextjs-data` on every `/_next/data/<any build>/…json` request and strips a
// client-sent value. A `nextUrl.buildId` means a tab from another build: its 404 is what makes that
// tab reload, and this build's manifest says nothing about that tab's pages. That id reaches the
// proxy ONLY with `i18n` configured: Next 16 strips this server's own id, and for any other id the
// adapter clears it too, but the locale prefix Next adds to the proxy URL makes it re-parse back.
// Without `i18n` both look identical, hence the `i18n` check in readPropslessStaticPages.
function isPropslessDataRequest(request: NextRequest) {
  return (
    request.headers.has('x-nextjs-data') &&
    !request.nextUrl.buildId &&
    isPropslessPage(request.nextUrl.pathname)
  );
}

export const nextDataSkipMiddleware = createMiddleware({
  matcher: ['/:path*'],
  shouldRun: isPropslessDataRequest,
  handler: async () => {
    const response = NextResponse.json({});
    response.headers.set('x-middleware-skip', '1');
    response.headers.set(
      'cache-control',
      'private, no-cache, no-store, max-age=0, must-revalidate'
    );
    return response;
  },
});
