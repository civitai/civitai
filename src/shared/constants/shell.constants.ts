/**
 * A request carrying `?civ-shell=0` must get the full server render, never the static shell. It is
 * how a shell page that could not load its page data recovers without reloading into the same
 * shell again.
 */
export const SHELL_BYPASS_PARAM = 'civ-shell';
export const SHELL_BYPASS_VALUE = '0';

export const SHELL_PAGE_DATA_PREFIX = '/api/page-data';

/**
 * Set on the page request by `_app.getInitialProps` when it renders the static shell, to the shell
 * route's name. Read by the page's `getServerSideProps` (which Next runs after `_app`'s) and by
 * the render metrics. Here rather than in `~/server/shell` so the metrics need no server import.
 */
export const SHELL_REQ_KEY = 'civShellRoute';

/** Response header naming how a page was rendered; only a shell render sets it. */
export const SHELL_RENDER_HEADER = 'X-Civ-Render';

/** The headers only a successfully rendered shell may carry: the edge cache's, and the label. */
export const SHELL_EDGE_HEADERS = [
  'Cloudflare-CDN-Cache-Control',
  'Cache-Tag',
  SHELL_RENDER_HEADER,
] as const;

/** The page-data URL for a page URL: same path and query, under `/api/page-data`. */
export function shellPageDataUrl(pathname: string, search: string) {
  return `${SHELL_PAGE_DATA_PREFIX}${pathname}${search}`;
}
