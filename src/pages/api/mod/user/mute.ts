import * as z from 'zod';
import { setUserMuted } from '~/server/services/user.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.mute', {
  summary: 'Mute an account.',
  returns: '{ muted: true }',
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input) {
    await setUserMuted({ userId: input.userId, muted: true });
    return { muted: true, affected: { userIds: [input.userId] } };
  },
});
