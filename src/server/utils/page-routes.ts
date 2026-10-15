import fs from 'fs';
import path from 'path';

/** No route was reported (non-web clients, server-side callers). */
export const PAGE_ROUTE_NONE = 'none';
/** A route was reported but is not a known page pattern. */
export const PAGE_ROUTE_OTHER = 'other';

/**
 * Next writes this at build time; its keys are every page's route pattern. The dist dir mirrors
 * `distDir` in `next.config.mjs`; `next dev` builds into its `dev/` subdirectory, and lists only
 * pages compiled so far, so in dev a page first compiled after the first lookup labels `other`.
 */
export function pagesManifestPath(nodeEnv = process.env.NODE_ENV) {
  return path.resolve(
    process.cwd(),
    process.env.NEXT_DIST_DIR || '.next',
    ...(nodeEnv === 'development' ? ['dev'] : []),
    'server',
    'pages-manifest.json'
  );
}

/** The error page is internal but is a real rendered document (a thrown getServerSideProps). */
const ERROR_ROUTE = '/_error';

const isPageRoute = (route: string) =>
  route === ERROR_ROUTE ||
  (route !== '/api' && !route.startsWith('/api/') && !route.startsWith('/_'));

/** Never throws: an unreadable manifest yields an empty set, so every route labels as `other`. */
export function readPageRoutes(manifestPath: string): Set<string> {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    return new Set(Object.keys(manifest).filter(isPageRoute));
  } catch (e) {
    console.warn(
      `[page-routes] cannot read ${manifestPath}; every page route will be labelled "${PAGE_ROUTE_OTHER}": ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return new Set();
  }
}

let knownRoutes: Set<string> | undefined;

export function __resetPageRoutesForTest() {
  knownRoutes = undefined;
}

/**
 * Maps a route to a metric label. Only page patterns from the build's manifest pass through, so a
 * client cannot add series by sending arbitrary values.
 */
export function pageRouteLabel(raw: string | string[] | null | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return PAGE_ROUTE_NONE;
  knownRoutes ??= readPageRoutes(pagesManifestPath());
  return knownRoutes.has(value) ? value : PAGE_ROUTE_OTHER;
}
