import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';

import { getBuzzLedgerTypes } from '$lib/server/user-account.service';

// Its own endpoint so the filter does not depend on the rows it filters. Folded into the row fetch, the
// options reloaded on every selection — and the control vanished while they did, which is exactly when
// a moderator who picked the wrong type wants to pick another.
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  const raw = Number(url.searchParams.get('days'));
  const days = Number.isFinite(raw) && raw >= 1 && raw <= 730 ? Math.floor(raw) : 90;
  return json(
    await getBuzzLedgerTypes(userId, days, { includeBank: !!locals.grants['user.buzz.bank'] })
  );
};
