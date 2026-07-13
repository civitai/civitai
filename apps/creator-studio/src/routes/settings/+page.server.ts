import type { PageServerLoad } from './$types';
import { getPayoutStatus } from '$lib/server/payout';

// Membership comes from the layout (data.membership). Payout status is a small read here. No writes — the fee
// default is a fixed system suggestion (B9), and onboarding/billing/withdrawal are link-outs.
export const load: PageServerLoad = async ({ locals }) => {
  const payout = await getPayoutStatus(locals.user.id);
  return { payout };
};
