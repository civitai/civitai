import type { PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { getPageVisitSummary } from '$lib/server/page-visits';

const DAYS = 30;

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  const routes = await getPageVisitSummary(DAYS);
  const totalVisits = routes.reduce((sum, r) => sum + Number(r.visits), 0);
  return { routes, totalVisits, days: DAYS };
};
