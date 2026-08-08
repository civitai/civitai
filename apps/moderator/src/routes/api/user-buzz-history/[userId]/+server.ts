import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getBuzzHistory } from '$lib/server/user-account.service';

// Its own endpoint rather than folded into /api/user-account: this reads a 1.5B-row ClickHouse table
// (~2.5s even bounded to 90 days), and the account panel should not wait on a question most lookups
// never ask.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  return json(await getBuzzHistory(userId));
};
