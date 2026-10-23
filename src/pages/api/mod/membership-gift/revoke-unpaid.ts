import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { revokeUnpaidMembershipGift } from '~/server/services/membership-gift.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('membershipGift.revokeUnpaid', {
  summary: "Revoke a membership gift that was granted before the gifter's payment cleared.",
  returns:
    "{ outcome: 'would-revoke' | 'revoked', paymentIntentId, paymentStatus, selfGift, effect, notified } | { outcome: 'skipped' | 'stopped', reason } | { outcome: 'already-revoked' | 'not-found' }",
  notes: [
    'Requires the moderator app permission `user.membership.gift`.',
    'Dry run unless `execute=true`: reports what would happen, read from live Stripe, and changes nothing.',
    'Skips a gift whose payment has succeeded or is processing. Stops without changes when any money has reached the payment or the customer cash balance.',
    "On execute, cancels the gift's PaymentIntent first, then revokes the gift as payment_failed. Idempotent: a revoked gift answers `already-revoked`.",
    '`notify=true` sends the holder a site notification, only when they lose something live.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    giftId: z.string().trim().min(1).max(64),
    execute: moderatorBoolean.default(false),
    notify: moderatorBoolean.default(false),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.gift')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Revoking a membership gift needs the "user.membership.gift" moderator permission.',
      });

    const result = await revokeUnpaidMembershipGift(input);
    return { ...result, affected: { membershipGiftIds: [input.giftId] } };
  },
});
