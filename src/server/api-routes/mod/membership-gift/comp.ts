import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { giftableTierSchema } from '~/server/schema/membership-gift.schema';
import {
  COMP_GIFT_LIMITS,
  compMembershipGift,
} from '~/server/services/membership-gift-comp.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('membershipGift.comp', {
  summary: 'Give a member a membership gift that nobody pays for (a comp).',
  returns:
    "{ outcome: 'would-comp', recipient, tier, months, giftability, compsInLast24h } | { outcome: 'comped', giftId, recipient, tier, months, fulfilled }",
  notes: [
    'Requires the moderator app permission `user.membership.gift.comp`.',
    'Dry run unless `execute=true`: reports who would receive it and what their membership can take, and changes nothing.',
    `The acting moderator is the gifter. ${COMP_GIFT_LIMITS.maxMonths} months at most; at most ${COMP_GIFT_LIMITS.dailyPerModerator} comps per moderator in any 24 hours.`,
    'Refuses a deleted, banned or muted recipient, your own account, and a membership that cannot take gifted months.',
    'The gift is fulfilled like a paid one: the recipient is notified and emailed, and accepts it themselves. A ModActivity row is written against the recipient.',
  ],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: z.object({
    userId,
    tier: giftableTierSchema,
    months: z.coerce.number().int().min(1).max(COMP_GIFT_LIMITS.maxMonths),
    reason: z
      .string()
      .trim()
      .min(10)
      .max(500)
      .describe('Why this gift is comped. Never shown to the recipient.'),
    message: z.string().trim().max(500).optional().describe('A note the recipient sees.'),
    anonymous: moderatorBoolean.default(false),
    execute: moderatorBoolean.default(false),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.gift.comp')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Comping a membership gift needs the "user.membership.gift.comp" moderator permission.',
      });

    const result = await compMembershipGift({
      recipientId: input.userId,
      tier: input.tier,
      months: input.months,
      reason: input.reason,
      message: input.message,
      anonymous: input.anonymous,
      execute: input.execute,
      moderatorId: ctx.actor.id,
    });
    return {
      ...result,
      affected: {
        userIds: [input.userId],
        ...(result.outcome === 'comped' ? { membershipGiftIds: [result.giftId] } : {}),
      },
    };
  },
});
