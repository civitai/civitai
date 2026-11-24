import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { confirmMemorial } from '~/server/services/memorial.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { trackModActivity } from '~/server/services/moderator.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.memorialConfirm', {
  summary:
    'Confirm a pending memorialization. Signs the account out everywhere and expires its API keys.',
  returns: '{ status: "active", keysExpired, orchestratorConfirmed, auditRecorded }',
  notes: [
    'Requires the moderator app permission `user.memorialize`.',
    'The confirming moderator must not be the one who proposed it; the write itself refuses that.',
    'Also excludes the account from event points, and reversing clears that only if this set it.',
  ],
  rateLimit: { max: 20, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.memorialize')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Memorializing an account needs the "user.memorialize" moderator permission.',
      });
    const revoked = await confirmMemorial({ userId: input.userId, actorId: ctx.actor.id });
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
