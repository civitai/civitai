import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { refundUnfulfilledMembershipGift } from '~/server/services/membership-gift.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('membershipGift.refundUnfulfilled', {
  summary:
    'Refund a membership gift whose payment cleared but which was never fulfilled, and mark it Refunded.',
  returns:
    "{ outcome: 'would-refund' | 'refunded', paymentIntentId, chargeId, amount, currency, refundId? } | { outcome: 'would-mark-refunded' | 'marked-refunded', paymentIntentId, chargeId } | { outcome: 'skipped', reason } | { outcome: 'already-refunded' | 'not-found' }",
  notes: [
    'Requires the moderator app permission `user.membership.gift`.',
    'Dry run unless `execute=true`.',
    "Only a Pending gift whose payment succeeded. Refunds the charge's unrefunded amount to the original payment method, then marks the gift Refunded.",
    'A gift whose charge is already fully refunded is only marked Refunded; no money moves.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    giftId: z.string().trim().min(1).max(64),
    execute: moderatorBoolean.default(false),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.gift')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Refunding a membership gift needs the "user.membership.gift" moderator permission.',
      });

    const result = await refundUnfulfilledMembershipGift(input);
    return { ...result, affected: { membershipGiftIds: [input.giftId] } };
  },
});
