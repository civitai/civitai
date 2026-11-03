import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { MEMBERSHIP_EXTEND_MAX_DAYS } from '~/server/schema/membership-extend.schema';
import { extendMembership } from '~/server/services/membership-extend.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.membership-extend', {
  summary: 'Give a Stripe member free days: the next charge (or the cancel) moves out by N days.',
  returns:
    '{ ok, userId, subscriptionId, days, trialEnd, mode, before, after, cancelRestored, newInvoiceId, problems }',
  notes: [
    'Requires the moderator app permission `user.membership.extend`.',
    `Stripe monthly plans in active or trialing status only; 1 to ${MEMBERSHIP_EXTEND_MAX_DAYS} days; one extension per member in 25 days; never your own membership.`,
    'Preview first (`/api/mod/user/membership-extend-preview`) and pass its `expectedCurrentPeriodEnd`: a membership that changed since is refused with 409.',
    '`ok: false` with a 200 means Stripe was written to and a post-check failed: check the subscription in Stripe before doing anything else. It is never retried or undone automatically.',
  ],
  rateLimit: { max: 5, windowSeconds: 60 },
  input: z.object({
    userId,
    days: z.coerce.number().int().min(1).max(MEMBERSHIP_EXTEND_MAX_DAYS),
    reason: z
      .string()
      .trim()
      .min(10)
      .max(500)
      .describe('Why: the support ticket and what went wrong.'),
    expectedCurrentPeriodEnd: z.coerce
      .number()
      .int()
      .positive()
      .describe('current_period_end (epoch seconds) from the preview.'),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.extend')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Extending a membership needs the "user.membership.extend" moderator permission.',
      });

    const result = await extendMembership({ ...input, actorId: ctx.actor.id });
    return { ...result, affected: { userIds: [input.userId] } };
  },
});
