import * as z from 'zod';
import { voidStrike } from '~/server/services/strike.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('strike.void', {
  summary: 'Void an active strike.',
  returns: '{ strike }',
  notes: ['`voidedBy` is the calling moderator.'],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    strikeId: z.coerce.number().int().positive().describe('The strike to void.'),
    voidReason: z.string().trim().min(1).max(1000).describe('Why it is being voided.'),
  }),
  async handler(input, ctx) {
    const strike = await voidStrike({
      strikeId: input.strikeId,
      voidReason: input.voidReason,
      voidedBy: ctx.actor.id,
    });
    return { strike, affected: { userIds: [strike.userId] } };
  },
});
