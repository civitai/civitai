import * as z from 'zod';
import { revokeCompMembershipGift } from '~/server/services/membership-gift-comp.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('membershipGift.compRevoke', {
  summary: 'Take back a comped membership gift, given by mistake, that has not been accepted.',
  returns:
    "{ outcome: 'would-revoke' | 'revoked', giftId, status, monthsRemaining } | { outcome: 'already-revoked', status }",
  notes: [
    'Requires the moderator app permission `user.membership.gift.comp`.',
    'Dry run unless `execute=true`. Idempotent: a revoked gift answers `already-revoked`.',
    'Comped gifts only; a paid gift is refused (use revoke-unpaid or refund-unfulfilled). An accepted comp is refused: acceptance can move the holder up a tier, so taking it back needs an engineer.',
    'On execute, marks the gift Revoked; the holder loses the gift before it ever touched their membership. A ModActivity row is written against the holder.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    giftId: z.string().trim().min(1).max(64),
    execute: moderatorBoolean.default(false),
  }),
  async handler(input, ctx) {
    const result = await revokeCompMembershipGift({
      giftId: input.giftId,
      execute: input.execute,
      actor: ctx.actor,
    });
    return { ...result, affected: { membershipGiftIds: [input.giftId] } };
  },
});
