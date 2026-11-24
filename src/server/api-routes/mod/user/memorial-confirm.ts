import * as z from 'zod';
import { logToAxiom } from '~/server/logging/client';
import { confirmMemorial } from '~/server/services/memorial.service';
import { assertMemorialModerator, memorialEffects } from '~/server/services/memorial-moderator';
import { trackModActivity } from '~/server/services/moderator.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.memorialConfirm', {
  summary:
    'Confirm a pending memorialization. Signs the account out everywhere and expires its API keys.',
  returns:
    '{ status: "active", sessionsRevoked, keysRevoked, orchestratorConfirmed, auditRecorded }',
  notes: [
    'Requires the moderator app permission `user.memorialize`, and refuses an impersonation session.',
    'The confirming moderator must not be the one who proposed it, and `proposedAt` must match the proposal still waiting; the write itself refuses either.',
    'Also excludes the account from event points, and reversing clears that only if this set it.',
  ],
  rateLimit: { max: 20, windowSeconds: 60 },
  input: z.object({
    userId,
    proposedAt: z
      .string()
      .min(1)
      .describe('The proposal being confirmed, as the moderator saw it.'),
  }),
  async handler(input, ctx) {
    await assertMemorialModerator(ctx);
    const revoked = await confirmMemorial(
      {
        userId: input.userId,
        actorId: ctx.actor.id,
        proposedAt: input.proposedAt,
      },
      memorialEffects
    );
    const result = { status: 'active' as const, ...revoked };

    let auditRecorded = true;
    try {
      await trackModActivity(ctx.actor.id, {
        entityType: 'user',
        entityId: input.userId,
        activity: 'memorialConfirm',
      });
    } catch (e) {
      auditRecorded = false;
      logToAxiom({
        type: 'error',
        name: 'mod-memorial-confirm-audit-failed',
        message: (e as Error).message,
        userId: input.userId,
        details: { moderatorId: ctx.actor.id },
      });
    }
    return { ...result, auditRecorded, affected: { userIds: [input.userId] } };
  },
});
