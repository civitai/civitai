import * as z from 'zod';
import { trackModActivity } from '~/server/services/moderator.service';
import { setUserMuted } from '~/server/services/user.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.unmute', {
  summary: 'Unmute an account.',
  returns: '{ muted: false }',
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input, { actor }) {
    await setUserMuted({ userId: input.userId, muted: false });
    await trackModActivity(actor.id, {
      entityType: 'user',
      entityId: input.userId,
      activity: 'unmute',
    });
    return { muted: false, affected: { userIds: [input.userId] } };
  },
});
