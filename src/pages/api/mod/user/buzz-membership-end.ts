import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { endBuzzMembership } from '~/server/services/subscriptions.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.buzz-membership-end', {
  summary: 'End an account’s Buzz-purchased membership now.',
  returns:
    '{ subscriptionId, productId, previousStatus, currentPeriodEnd, endedAt, freshdeskSynced }',
  notes: [
    'Requires the moderator app permission `user.membership.code`.',
    'Only the membership bought with Buzz; a Stripe or redeemed-code membership is untouched. 404 when there is none to end.',
    'Sets the row to canceled with canceledAt and endedAt now, so the tier stops at once. Moves no Buzz: refund the purchase separately.',
    'A ModActivity row is written against the account.',
  ],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: z.object({
    userId,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe('Why, e.g. the support ticket. Recorded in the audit; the user does not see it.'),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.code')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Ending a Buzz-purchased membership needs the "user.membership.code" moderator permission.',
      });

    const ended = await endBuzzMembership({ userId: input.userId, moderatorId: ctx.actor.id });
    return { ...ended, affected: { userIds: [input.userId] } };
  },
});
