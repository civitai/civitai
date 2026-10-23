/**
 * A request carrying `?civ-shell=0` must get the full server render, never the static shell. It is
 * how a shell page that could not load its page data recovers without reloading into the same
 * shell again.
 */
export const SHELL_BYPASS_PARAM = 'civ-shell';
export const SHELL_BYPASS_VALUE = '0';

export const SHELL_PAGE_DATA_PREFIX = '/api/page-data';

/** The page-data URL for a page URL: same path and query, under `/api/page-data`. */
export function shellPageDataUrl(pathname: string, search: string) {
  return `${SHELL_PAGE_DATA_PREFIX}${pathname}${search}`;
}
