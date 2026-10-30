import * as z from 'zod';
import { setUserMuted } from '~/server/services/user.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.mute', {
  summary: 'Mute an account, indefinitely or until a given time.',
  returns: '{ muted: true, expiresAt }',
  notes: [
    'Omit `expiresAt` for an indefinite mute; send it for a timed one that `processTimedUnmutes` lifts.',
    'A timed mute is still lifted early by strike de-escalation, which keys on the expiry being set.',
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
    await setUserMuted({ userId: input.userId, muted: true, expiresAt: input.expiresAt ?? null });
    return {
      muted: true,
      expiresAt: input.expiresAt ?? null,
      affected: { userIds: [input.userId] },
    };
  },
});
