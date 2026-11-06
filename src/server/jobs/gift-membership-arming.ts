import { createJob } from './job';
import { sweepGiftArming, sweepGiftTierReverts } from '~/server/services/membership-gift.service';

/**
 * Backstop for the event-driven arming in the gift service. Arming normally happens on
 * `invoice.paid`; if that webhook is missed or the Stripe call failed, a holder sits with
 * gifted months owed and nothing on their subscription — and gets billed full price for a
 * month we already took money for.
 *
 * Also the only trigger for moving a holder back down once a higher-tier gift runs out: no
 * Stripe event fires shortly before a renewal, so the revert waits for the run before it.
 */
export const giftMembershipArming = createJob('gift-membership-arming', '15 * * * *', async () => {
  // A failed arming pass must not cost a holder their revert, which has no other trigger.
  const arming = await sweepGiftArming().catch((error) => ({ error: String(error) }));
  const reverts = await sweepGiftTierReverts();
  return { arming, reverts };
});
