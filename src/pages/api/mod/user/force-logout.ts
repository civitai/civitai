import * as z from 'zod';
import { invalidateSession } from '~/server/auth/session-invalidation';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.forceLogout', {
  summary: 'Invalidate every active session on an account.',
  returns: '{ loggedOut: true }',
  notes: ['Sessions only — this does not mute, ban or otherwise change the account.'],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input) {
    await invalidateSession(input.userId, 'moderation');
    return { loggedOut: true, affected: { userIds: [input.userId] } };
  },
});
