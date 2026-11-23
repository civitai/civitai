import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { previewMembershipCancel } from '~/server/services/membership-cancel.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { booleanString } from '~/utils/zod-helpers';

export default defineModeratorEndpoint('user.membership-cancel-preview', {
  method: 'GET',
  summary:
    'What setting or undoing cancel-at-period-end on a Stripe membership would do, and the problems that would refuse it.',
  returns: '{ userId, cancelAtPeriodEnd, subscription, problems, changed }',
  notes: [
    'Requires the moderator app permission `user.membership.cancel`.',
    'Read-only. An empty `problems` means `/api/mod/user/membership-cancel` would accept it now; `changed: false` means it is already so.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({ userId, cancelAtPeriodEnd: booleanString() }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.cancel')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Changing a membership cancel needs the "user.membership.cancel" moderator permission.',
      });
    return previewMembershipCancel({ ...input, actorId: ctx.actor.id });
  },
});
