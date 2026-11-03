import * as z from 'zod';
import { expireGenerationCredentialsIfMuted } from '~/server/services/account-standing.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.expireGenerationCredentials', {
  summary: "Expire a muted account's generation keys and AI Services app tokens.",
  returns: '{ ok: true }',
  notes: [
    'For a mute written outside the main app. Does nothing for an account that is not muted.',
    'Personal API keys and the site session are left alone.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input) {
    await expireGenerationCredentialsIfMuted(input.userId);
    return { ok: true, affected: { userIds: [input.userId] } };
  },
});
