import singletonRouter from 'next/router';
import { PAGE_ROUTE_HEADER } from '~/shared/constants/page-route.constants';

/**
 * The current page's route PATTERN (e.g. `/models/[id]/[[...slug]]`) — never the concrete URL,
 * which would carry ids and slugs into a metric label. Browser only.
 */
export function pageRouteHeaders(): Partial<Record<typeof PAGE_ROUTE_HEADER, string>> {
  if (typeof window === 'undefined') return {};
  const pageRoute = singletonRouter.router?.pathname;
  return pageRoute ? { [PAGE_ROUTE_HEADER]: pageRoute } : {};
}
