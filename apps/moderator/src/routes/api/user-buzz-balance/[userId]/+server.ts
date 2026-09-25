import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getBuzzBalance } from '$lib/server/user-account.service';

// Its own endpoint: three Buzz-service calls, versus /api/user-account whose slowest member is a
// reaction aggregate over 744M rows. One `Promise.all` made the balance as slow as the slowest list
// on the page.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  return json(await getBuzzBalance(userId));
};
