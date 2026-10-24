import * as z from 'zod';
import { releaseUserMute } from '~/server/services/mute-release.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.unmute', {
  summary:
    'Unmute an account. `activity: "revokeTimedMute"` lifts only a timed mute and refuses anything else.',
  returns: '{ muted: false }',
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    userId,
    activity: z.enum(['unmute', 'revokeTimedMute']).default('unmute'),
  }),
  async handler(input, { actor }) {
    const result = await releaseUserMute({
      userId: input.userId,
      actorId: actor.id,
      activity: input.activity,
      onlyIfTimed: input.activity === 'revokeTimedMute',
      updateSource: 'retool:unmute',
    });
    if (!result.released) {
      if (result.reason === 'not-found')
        throw throwNotFoundError(`No user with id ${input.userId}`);
      throw throwBadRequestError('No timed mute is in force on this account.');
    }
    return { muted: false, affected: { userIds: [input.userId] } };
  },
});
