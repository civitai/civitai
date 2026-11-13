import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import {
  SUPPORT_MEMBERSHIP_CODE_LIMITS,
  SUPPORT_MEMBERSHIP_CODE_TIERS,
  mintSupportMembershipCode,
} from '~/server/services/support-membership-code.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.membership-code', {
  summary:
    'Mint one membership redeem code for a customer, to make them whole after a billing problem.',
  returns: '{ code, expiresAt, tier, months }',
  notes: [
    'Requires the moderator app permission `user.membership.code`.',
    `Civitai-provider (yellow Buzz) monthly prices only; ${SUPPORT_MEMBERSHIP_CODE_LIMITS.maxMonths} months at most; the code expires after ${SUPPORT_MEMBERSHIP_CODE_LIMITS.expiryDays} days.`,
    `At most ${SUPPORT_MEMBERSHIP_CODE_LIMITS.dailyPerModerator} codes per moderator in any 24 hours.`,
    'The customer redeems the code at /redeem-code. The minter, target account and reason are stored on the code; a ModActivity row is written against the target account.',
  ],
  rateLimit: { max: 5, windowSeconds: 60 },
  input: z.object({
    userId,
    tier: z.enum(SUPPORT_MEMBERSHIP_CODE_TIERS),
    months: z.coerce.number().int().min(1).max(SUPPORT_MEMBERSHIP_CODE_LIMITS.maxMonths),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe('Why: the support ticket and what went wrong.'),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.code')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Minting membership codes needs the "user.membership.code" moderator permission.',
      });

    const minted = await mintSupportMembershipCode({
      forUserId: input.userId,
      tier: input.tier,
      months: input.months,
      reason: input.reason,
      moderatorId: ctx.actor.id,
    });

    return { ...minted, affected: { userIds: [input.userId] } };
  },
});
