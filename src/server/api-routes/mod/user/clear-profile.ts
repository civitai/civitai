import * as z from 'zod';
import { archiveUserProfile } from '~/server/services/csam.service-new';
import { clearUserProfileFields } from '~/server/services/user.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { PROFILE_CLEAR_FIELDS, userId } from '~/server/schema/moderator/user';

export const clearProfileInput = z.object({
  userId,
  fields: z
    .array(z.enum(PROFILE_CLEAR_FIELDS))
    .min(1)
    .describe('Which fields to clear: at least one.'),
});

export default defineModeratorEndpoint('user.clearProfile', {
  summary: 'Blank profile text an account has filled in.',
  rateLimit: { max: 60, windowSeconds: 60 },
  input: clearProfileInput,
  async handler(input, ctx) {
    const result = await clearUserProfileFields({
      userId: input.userId,
      fields: input.fields,
      actorId: ctx.actor.id,
      archive: archiveUserProfile,
    });
    return { ...result, affected: { userIds: [input.userId] } };
  },
});
