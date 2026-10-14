import { PAGE_ROUTES } from '~/server/utils/page-routes.list';

export const PAGE_ROUTE_HEADER = 'x-page-route';

/** No route was reported (non-web clients, server-side callers). */
export const PAGE_ROUTE_NONE = 'none';
/** A route was reported but is not a known page pattern. */
export const PAGE_ROUTE_OTHER = 'other';

const knownRoutes = new Set<string>(PAGE_ROUTES);

/**
 * Maps a client-reported route to a metric label. Only known page patterns pass through, so a
 * client cannot add series by sending arbitrary values.
 */
export function pageRouteLabel(raw: string | string[] | null | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return PAGE_ROUTE_NONE;
  return knownRoutes.has(value) ? value : PAGE_ROUTE_OTHER;
}
