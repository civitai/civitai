import * as z from 'zod';
import { archiveUserProfile } from '~/server/services/csam.service-new';
import { removeUserLinkAsModerator } from '~/server/services/user.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.removeLink', {
  summary: "Remove one of an account's social or sponsorship links.",
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    userId,
    linkId: z.number().int().positive().describe('The UserLink id; it must belong to userId.'),
  }),
  async handler(input, ctx) {
    const result = await removeUserLinkAsModerator({
      userId: input.userId,
      linkId: input.linkId,
      actorId: ctx.actor.id,
      archive: archiveUserProfile,
    });
    return { ...result, affected: { userIds: [input.userId] } };
  },
});
