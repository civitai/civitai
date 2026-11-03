import * as z from 'zod';
import { setUserMuted } from '~/server/services/user.service';
import {
  CommittedRetryableError,
  defineModeratorEndpoint,
} from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.mute', {
  summary: 'Mute an account, indefinitely or until a given time.',
  returns: '{ muted: true, expiresAt }',
  notes: [
    'Omit `expiresAt` for an indefinite mute; send it for a timed one that `processTimedUnmutes` lifts.',
    'A timed mute is still lifted early by strike de-escalation, which keys on the expiry being set.',
    'A 503 means the mute was applied but the account could not be signed out everywhere; repeat the same call. A repeat keeps the original `mutedAt`.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    userId,
    expiresAt: z.coerce.date().optional().describe('When the mute lifts. Omit for indefinite.'),
  }),
  async handler(input) {
    // `?? null`, never a pass-through: `setUserMuted` writes the column only when the caller names a
    // value, and the account may already carry a `muteExpiresAt` from a strike. Omitting it would
    // leave that date in place, so `processTimedUnmutes` would lift this indefinite mute on it.
    const { sessionInvalidated } = await setUserMuted({
      userId: input.userId,
      muted: true,
      expiresAt: input.expiresAt ?? null,
    });
    // Repeating this mute is harmless, so a caller can be told to retry the session step.
    if (!sessionInvalidated)
      throw new CommittedRetryableError(
        'The account is muted but its sessions could not be ended; retry',
        { userIds: [input.userId] }
      );
    return {
      muted: true,
      expiresAt: input.expiresAt ?? null,
      affected: { userIds: [input.userId] },
    };
  },
});
