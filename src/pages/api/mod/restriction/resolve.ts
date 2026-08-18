import * as z from 'zod';
import { resolveUserRestriction } from '~/server/services/user-restriction-resolve.service';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('restriction.resolve', {
  summary: 'Rule on a pending generation restriction.',
  returns: '{ resolved }',
  notes: [
    'Clearing the mute alone resolves nothing — this is the write path that also closes the row, the subscription and the notification.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    userRestrictionId: z.coerce.number().int().positive().describe('The restriction to rule on.'),
    // Pending is not offered: it is the state being ruled on, and the service refuses anything
    // already resolved.
    status: z
      .enum([UserRestrictionStatus.Overturned, UserRestrictionStatus.Upheld])
      .describe('The verdict.'),
    resolvedMessage: z.string().trim().max(1000).optional().describe('Shown to the user.'),
  }),
  async handler(input, ctx) {
    const { userId } = await resolveUserRestriction({
      userRestrictionId: input.userRestrictionId,
      status: input.status,
      resolvedMessage: input.resolvedMessage,
      moderatorId: ctx.actor.id,
    });
    return { resolved: input.status, affected: { userIds: [userId] } };
  },
});
