import type { PageServerLoad } from './$types';
import { accountActions, loadAccount } from './account.server';

// The bare queue opens its first account, as the model queue does: the detail space is for working a
// report, and an empty panel asking for a click was one more step per report. Rendered here rather
// than redirected to `/reports/user/<id>` — a redirect would run the queue twice on every filter
// change, once for this URL and again for the one it named.
export const load: PageServerLoad = async ({ parent, url, locals }) => {
  const { items } = await parent();
  const first = items.find((r) => r.entityId != null)?.entityId;
  return { account: first ? await loadAccount(first, 'details', url, locals) : null };
};

export const actions = accountActions;
