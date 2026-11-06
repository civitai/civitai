import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { MEMBERSHIP_EXTEND_MAX_DAYS } from '~/server/schema/membership-extend.schema';
import { previewMembershipExtension } from '~/server/services/membership-extend.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.membership-extend-preview', {
  method: 'GET',
  summary:
    'What extending a Stripe membership by N days would do, and every reason it would be refused.',
  returns:
    '{ userId, days, subscription, problems, keyMode, expectedCurrentPeriodEnd, trialEnd, trialEndIso, mode }',
  notes: [
    'Requires the moderator app permission `user.membership.extend`.',
    'Read-only. An empty `problems` means `/api/mod/user/membership-extend` would accept it now; pass `expectedCurrentPeriodEnd` back to it.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    userId,
    days: z.coerce.number().int().min(1).max(MEMBERSHIP_EXTEND_MAX_DAYS),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.extend')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Extending a membership needs the "user.membership.extend" moderator permission.',
      });
    return previewMembershipExtension({ ...input, actorId: ctx.actor.id });
  },
});
