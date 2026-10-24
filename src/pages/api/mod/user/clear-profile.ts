import * as z from 'zod';
import { clearUserProfileFields } from '~/server/services/user.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.clearProfile', {
  summary: 'Blank profile text an account has filled in.',
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    userId,
    fields: z
      .array(z.enum(['location', 'bio', 'message']))
      .optional()
      .describe('Which fields to clear. Omit to clear all three.'),
  }),
  async handler(input) {
    const result = await clearUserProfileFields({ userId: input.userId, fields: input.fields });
    return { ...result, affected: { userIds: [input.userId] } };
  },
});
