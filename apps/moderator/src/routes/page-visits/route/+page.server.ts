import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { getRouteUserBreakdown } from '$lib/server/page-visits';

const DAYS = 30;

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  const location = url.searchParams.get('location');
  if (!location) error(400, 'Missing ?location route to break down.');

  const users = await getRouteUserBreakdown(location, DAYS);
  const totalVisits = users.reduce((sum, u) => sum + Number(u.visits), 0);
  return { location, users, totalVisits, days: DAYS };
};
