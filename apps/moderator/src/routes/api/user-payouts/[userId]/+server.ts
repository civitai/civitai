import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getPayouts } from '$lib/server/user-account.service';

// Client-fetched like the rest of this page's panels: two indexed reads, and almost every account has
// no payouts at all, so it does not belong in the identity render path.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  return json(await getPayouts(userId));
};
