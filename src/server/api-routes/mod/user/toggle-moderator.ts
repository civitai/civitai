import * as z from 'zod';
import { setUserModerator } from '~/server/services/user.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.toggleModerator', {
  summary: 'Grant or remove the moderator role.',
  returns: '{ isModerator }',
  privileged: 'retoolToggleModerator',
  rateLimit: { max: 10, windowSeconds: 60 },
  input: z.object({
    userId,
    isModerator: moderatorBoolean.describe('True to make a moderator, false to remove.'),
  }),
  async handler(input, ctx) {
    await setUserModerator({
      userId: input.userId,
      isModerator: input.isModerator,
      actorId: ctx.actor.id,
    });
    return { isModerator: input.isModerator, affected: { userIds: [input.userId] } };
  },
});
