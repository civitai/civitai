import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { setMembershipCancel } from '~/server/services/membership-cancel.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.membership-cancel', {
  summary:
    "Set (true) or undo (false) cancel-at-period-end on a member's Stripe membership. Moves no money now.",
  returns:
    '{ ok, userId, subscriptionId, cancelAtPeriodEnd, changed, before, after, problems, written }',
  notes: [
    'Requires the moderator app permission `user.membership.cancel`.',
    'Stripe active or trialing only; never a custom cancel date (a gift end), a schedule, a moderator or your own membership. Undo is also refused for a ban/mute cancel, a banned or muted member, and a membership gift.',
    'Already in that state: nothing is written, `changed: false`.',
    '`ok: false` with a 200: the write or its check did not complete cleanly (see `problems`); `written` says whether Stripe took it (null: unknown). Check Stripe before anything else.',
  ],
  rateLimit: { max: 5, windowSeconds: 60 },
  input: z.object({
    userId,
    cancelAtPeriodEnd: z.boolean(),
    reason: z
      .string()
      .trim()
      .min(10)
      .max(500)
      .describe('Why: the support ticket and what the member asked for.'),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.cancel')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Changing a membership cancel needs the "user.membership.cancel" moderator permission.',
      });
    const result = await setMembershipCancel({ ...input, actorId: ctx.actor.id });
    return { ...result, affected: { userIds: [input.userId] } };
  },
});
