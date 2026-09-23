import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';

import { getBuzzHistory } from '$lib/server/user-account.service';

// Its own endpoint rather than folded into /api/user-account: this reads a 1.5B-row ClickHouse table
// (~2.5s even bounded to 90 days), and the account panel should not wait on a question most lookups
// never ask.
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  // Retool's `After date` picker. Bounded because the table is 1.5B rows: a moderator can widen the
  // window, not remove it.
  const raw = Number(url.searchParams.get('days'));
  const days = Number.isFinite(raw) && raw >= 1 && raw <= 730 ? Math.floor(raw) : 90;
  // Per SIDE, not across both — see `getBuzzHistory`.
  const rawLimit = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1 && rawLimit <= 2000 ? Math.floor(rawLimit) : 200;
  // Retool hid `type = 'bank'` rows from everyone except admins and two hardcoded names — a restriction
  // that lived in the TABLE'S DATA BINDING, not in a query or a pane gate, which is why the port
  // widened it without anyone noticing. Ported as a grant: hardcoding names is what left this app's
  // moderator list stale in three other places.
  const includeBank = !!locals.grants['user.buzz.bank'];
  // Narrowing to a type RE-QUERIES that side rather than filtering the page, so a purchase behind
  // thousands of rewards becomes reachable. `getBuzzHistory` validates the value before it reaches the
  // SQL; `bank` is refused here as well, or the filter would be a way to read rows the grant withholds.
  const sideType = (param: string) => {
    const value = url.searchParams.get(param)?.trim();
    if (!value || value === 'all') return undefined;
    if (value === 'bank' && !includeBank) return undefined;
    return value;
  };

  return json(
    await getBuzzHistory(userId, days, {
      limit,
      includeBank,
      paymentType: sideType('paymentType'),
      receiptType: sideType('receiptType'),
    })
  );
};
