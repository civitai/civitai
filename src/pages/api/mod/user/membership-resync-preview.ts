import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { previewMembershipResync } from '~/server/services/membership-resync.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.membership-resync-preview', {
  method: 'GET',
  summary:
    "A member's CustomerSubscription row beside Stripe's copy: what differs, and any Buzz-bought membership a re-sync would end.",
  returns: '{ userId, ours, stripe, changes, endsBuzzMembership, problems }',
  notes: [
    'Requires the moderator app permission `user.membership.extend`.',
    'Read-only, Stripe included. An empty `problems` means `/api/mod/user/membership-resync` would accept it now; with `endsBuzzMembership` set it needs `confirmEndBuzzMembership: true`.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.extend')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Re-syncing a membership needs the "user.membership.extend" moderator permission.',
      });
    return previewMembershipResync({ ...input, actorId: ctx.actor.id });
  },
});
