import singletonRouter from 'next/router';

export const PAGE_ROUTE_HEADER = 'x-page-route';

/**
 * The current page's route PATTERN (e.g. `/models/[id]/[[...slug]]`) — never the concrete URL,
 * which would carry ids and slugs into a metric label. Browser only.
 */
export function pageRouteHeaders(): { 'x-page-route'?: string } {
  if (typeof window === 'undefined') return {};
  const pageRoute = singletonRouter.router?.pathname;
  return pageRoute ? { [PAGE_ROUTE_HEADER]: pageRoute } : {};
}
