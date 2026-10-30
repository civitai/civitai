import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getCsamReports } from '$lib/server/user-account.service';

// Client-fetched so the header chip costs nothing on accounts that have no CSAM report — which is
// almost all of them, and the chip already knows the count from the identity query.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  return json(await getCsamReports(userId));
};
