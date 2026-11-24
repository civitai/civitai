import * as z from 'zod';
import { logToAxiom } from '~/server/logging/client';
import {
  memorialBases,
  memorialTributesSchema,
  proposeMemorial,
} from '~/server/services/memorial.service';
import { assertMemorialModerator } from '~/server/services/memorial-moderator';
import { trackModActivity } from '~/server/services/moderator.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.memorialPropose', {
  summary:
    'Propose memorializing an account whose holder has died. Nothing public changes until a second moderator confirms.',
  returns: '{ status: "pending", auditRecorded }',
  notes: [
    'Requires the moderator app permission `user.memorialize`, and refuses an impersonation session.',
    'Refuses a deleted or banned account, one already memorialized, and one with a proposal already waiting.',
    'Evidence and notes are not sent here: the moderator app keeps them in its own moderator notes.',
  ],
  rateLimit: { max: 20, windowSeconds: 60 },
  input: z.object({
    userId,
    basis: z.enum(memorialBases),
    tributes: memorialTributesSchema.default([]),
  }),
  async handler(input, ctx) {
    await assertMemorialModerator(ctx);
    const state = await proposeMemorial({
      userId: input.userId,
      actorId: ctx.actor.id,
      basis: input.basis,
      tributes: input.tributes,
    });
    const result = { status: state.status };

    let auditRecorded = true;
    try {
      await trackModActivity(ctx.actor.id, {
        entityType: 'user',
        entityId: input.userId,
        activity: 'memorialPropose',
      });
    } catch (e) {
      auditRecorded = false;
      logToAxiom({
        type: 'error',
        name: 'mod-memorial-propose-audit-failed',
        message: (e as Error).message,
        userId: input.userId,
        details: { moderatorId: ctx.actor.id },
      });
    }
    return { ...result, auditRecorded, affected: { userIds: [input.userId] } };
  },
});
