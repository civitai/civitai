import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { canAccess } from '$lib/server/access';
import { getSharedIpAccounts, softly } from '$lib/server/user-signals.service';

/**
 * The accounts sharing an address with one account — for the user report queue's User details tab,
 * where a bot ring is usually first noticed. Its own endpoint rather than `/api/user-signals`: that one
 * carries the addresses, socials, blocked prompts and account events, which the Reports grant this
 * queue sits under must not open, and runs eight queries for the one list wanted here.
 *
 * The shared address itself is returned only to a caller who could read it in User Lookup.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, ['/retool/user-lookup', '/reports/user']);
  const showIps = canAccess(locals.user, '/retool/user-lookup');
  const shared = await softly('sharedIps', () => getSharedIpAccounts(userId), {
    accounts: [],
    truncated: false,
  });
  return json({
    truncated: shared.truncated,
    accounts: shared.accounts.map((a) => (showIps ? a : { ...a, ip: null })),
  });
};
