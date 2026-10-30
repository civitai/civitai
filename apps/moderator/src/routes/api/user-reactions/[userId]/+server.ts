import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getReactionTargets } from '$lib/server/user-account.service';

// Its own endpoint because it is the slowest thing this page can ask for, and it is unbounded by
// design: it aggregates every reaction the account has ever given. Measured on production, one row per
// creator reacted to — 46,744 reactions across 2,058 creators takes 1.9s, 820,263 across 7,131 takes
// 20s, and there is no statement timeout, so it does not fail, it waits.
//
// Sharing `/api/user-account` made that wait everyone's: the other ten lists resolved in under a second
// and then sat behind this one. A reactions panel that is empty for twenty seconds reads as broken —
// reported as exactly that — and it took the whole page with it, on precisely the high-volume accounts
// a farming investigation is looking at.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  return json(await getReactionTargets(userId));
};
