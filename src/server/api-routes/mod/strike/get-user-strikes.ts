import * as z from 'zod';
import { getStrikesForUser } from '~/server/services/strike.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('strike.getUserStrikes', {
  summary: "Read an account's strikes, including internal notes.",
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    userId: z.coerce.number().int().positive().describe('The account to read.'),
    includeExpired: moderatorBoolean
      .optional()
      .describe('Include strikes that have already lapsed. Defaults to false.'),
  }),
  async handler(input) {
    const result = await getStrikesForUser(input.userId, {
      includeExpired: input.includeExpired ?? false,
      includeInternalNotes: true,
    });
    return { ...result, affected: { userIds: [input.userId] } };
  },
});
