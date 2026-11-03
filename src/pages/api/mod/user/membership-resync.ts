import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { resyncMembership } from '~/server/services/membership-resync.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.membership-resync', {
  summary:
    "Re-read a member's Stripe subscription into CustomerSubscription through the webhook's upsert. Writes nothing to Stripe.",
  returns: '{ ok, userId, subscriptionId, before, after, changes, endedBuzzMembership }',
  notes: [
    'Requires the moderator app permission `user.membership.extend`.',
    'With no row yet, syncs only when the customer has exactly one live subscription.',
    'Refused for an ended subscription (resend its deleted event from Stripe: that settles gifted months, which this does not) and for a lapsed one the customer has replaced.',
    'An active or trialing Stripe membership ends a live Buzz-bought one: refused unless `confirmEndBuzzMembership` is true (preview shows it).',
  ],
  rateLimit: { max: 5, windowSeconds: 60 },
  input: z.object({
    userId,
    reason: z
      .string()
      .trim()
      .min(10)
      .max(500)
      .describe('Why: the support ticket and what is out of sync.'),
    confirmEndBuzzMembership: z.boolean().default(false),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.extend')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Re-syncing a membership needs the "user.membership.extend" moderator permission.',
      });
    const result = await resyncMembership({ ...input, actorId: ctx.actor.id });
    return { ...result, affected: { userIds: [input.userId] } };
  },
});
