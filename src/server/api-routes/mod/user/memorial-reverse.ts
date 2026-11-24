import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { reverseMemorial } from '~/server/services/memorial.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { trackModActivity } from '~/server/services/moderator.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.memorialReverse', {
  summary: 'Cancel a pending memorialization, or lift an active one. One moderator is enough.',
  returns: '{ memorialized: false, auditRecorded }',
  notes: [
    'Requires the moderator app permission `user.memorialize`.',
    'Sessions and API keys revoked at confirmation are not restored; the holder signs in again.',
  ],
  rateLimit: { max: 20, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.memorialize')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Memorializing an account needs the "user.memorialize" moderator permission.',
      });
    await reverseMemorial({ userId: input.userId });
    const result = { memorialized: false };

    let auditRecorded = true;
    try {
      await trackModActivity(ctx.actor.id, {
        entityType: 'user',
        entityId: input.userId,
        activity: 'memorialReverse',
      });
    } catch (e) {
      auditRecorded = false;
      logToAxiom({
        type: 'error',
        name: 'mod-memorial-reverse-audit-failed',
        message: (e as Error).message,
        userId: input.userId,
        details: { moderatorId: ctx.actor.id },
      });
    }
    return { ...result, auditRecorded, affected: { userIds: [input.userId] } };
  },
});
