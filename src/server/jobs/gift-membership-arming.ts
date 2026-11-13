import { createJob } from './job';
import { sweepGiftArming } from '~/server/services/membership-gift.service';

/**
 * Backstop for the event-driven arming in the gift service. Arming normally happens on
 * `invoice.paid`; if that webhook is missed or the Stripe call failed, a holder sits with
 * gifted months owed and nothing on their subscription — and gets billed full price for a
 * month we already took money for.
 */
export const giftMembershipArming = createJob('gift-membership-arming', '15 * * * *', async () =>
  sweepGiftArming()
);
