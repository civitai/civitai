import * as z from 'zod';
import { cancelPendingWorkflowsIfMuted } from '~/server/services/account-standing.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.cancelPendingWorkflows', {
  summary: "Cancel a muted account's pending generations.",
  returns: '{ ok: true }',
  notes: [
    'For a mute written outside the main app, called before its tokens are revoked. Does nothing for an account that is not muted.',
    'Waits at most a few seconds; cancels still running then finish in the background.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input) {
    await cancelPendingWorkflowsIfMuted(input.userId);
    return { ok: true, affected: { userIds: [input.userId] } };
  },
});
