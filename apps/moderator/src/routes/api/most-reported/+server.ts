import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { getMostReported } from '$lib/server/reports.service';

// Client-fetched like the sidebar counts: the query joins six report tables and runs ~200ms, so it must
// not sit in the dashboard's render path. `/api/*` is exempt from the global route gate, so this checks
// report access itself rather than trusting the guard's authentication alone.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user || !canAccess(locals.user, '/reports')) return json([]);
  return json(await getMostReported());
};
