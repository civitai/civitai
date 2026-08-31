import type { PageServerLoad } from './$types';
import { getPayoutStatus } from '$lib/server/payout';
import { getCreatorCash } from '$lib/server/cash';

// Membership comes from the layout (data.membership). Payout status + cash balance are small reads. No writes —
// the fee default is a fixed system suggestion (B9), and onboarding/billing/withdrawal are link-outs. Cash gates
// the "set up payouts" prompt (#16) — we don't push creators into Tipalti signup before they can withdraw.
export const load: PageServerLoad = async ({ locals }) => {
  const [payout, cash] = await Promise.all([
    getPayoutStatus(locals.user.id),
    getCreatorCash({ userId: locals.user.id }).catch(() => null),
  ]);
  return { payout, cash };
};
