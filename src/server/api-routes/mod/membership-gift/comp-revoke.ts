import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { revokeCompMembershipGift } from '~/server/services/membership-gift-comp.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('membershipGift.compRevoke', {
  summary: 'Take back a comped membership gift that was given by mistake.',
  returns:
    "{ outcome: 'would-revoke' | 'revoked', giftId, status, monthsRemaining } | { outcome: 'already-revoked', status }",
  notes: [
    'Requires the moderator app permission `user.membership.gift.comp`.',
    'Dry run unless `execute=true`. Idempotent: a revoked gift answers `already-revoked`.',
    'Comped gifts only; a paid gift is refused (use revoke-unpaid or refund-unfulfilled). Refuses a gift whose months are all used, or one that started its own subscription.',
    'On execute, removes any armed month from the holder and marks the gift Revoked. A ModActivity row is written against the holder.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    giftId: z.string().trim().min(1).max(64),
    execute: moderatorBoolean.default(false),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.gift.comp')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Revoking a comped gift needs the "user.membership.gift.comp" moderator permission.',
      });

    const result = await revokeCompMembershipGift({
      giftId: input.giftId,
      execute: input.execute,
      moderatorId: ctx.actor.id,
    });
    return { ...result, affected: { membershipGiftIds: [input.giftId] } };
  },
});
