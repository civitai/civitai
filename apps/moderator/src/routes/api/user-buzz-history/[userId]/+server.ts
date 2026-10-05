import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';

import { getBuzzLedgerSide } from '$lib/server/user-account.service';

// ONE side per request. This reads a 1.5B-row ClickHouse table (~2.5s even bounded to 90 days), and
// the two columns carry independent filters — served together, narrowing the receipts type re-ran the
// payments query for an answer that had not changed, and blanked that column while it did.
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  const side = url.searchParams.get('side') === 'payments' ? 'payments' : 'receipts';
  // Retool's `After date` picker. Bounded because the table is 1.5B rows: a moderator can widen the
  // window, not remove it.
  const raw = Number(url.searchParams.get('days'));
  const days = Number.isFinite(raw) && raw >= 1 && raw <= 730 ? Math.floor(raw) : 90;
  const rawLimit = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1 && rawLimit <= 2000 ? Math.floor(rawLimit) : 200;
  // Retool hid `type = 'bank'` rows from everyone except admins and two hardcoded names — a restriction
  // that lived in the TABLE'S DATA BINDING, not in a query or a pane gate, which is why the port
  // widened it without anyone noticing. Ported as a grant: hardcoding names is what left this app's
  // moderator list stale in three other places.
  const includeBank = !!locals.grants['user.buzz.bank'];

  // Narrowing to a type RE-QUERIES this side rather than filtering the page, so a purchase behind
  // thousands of rewards becomes reachable. `getBuzzLedgerSide` validates the value before it reaches
  // the SQL; `bank` is refused here too, or the filter would read rows the grant withholds.
  const requested = url.searchParams.get('type')?.trim();
  const type =
    !requested || requested === 'all' || (requested === 'bank' && !includeBank)
      ? undefined
      : requested;

  return json(await getBuzzLedgerSide(userId, side, days, { limit, includeBank, type }));
};
