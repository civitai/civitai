import * as z from 'zod';
import { resolveMinorFlagAppeal } from '~/server/services/minor-hash.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('minorFlag.resolveAppeal', {
  summary: 'Rule on a pending minor-flag appeal.',
  returns: '{ resolved }',
  notes: ['Upholding refuses if the model is no longer flagged.'],
  rateLimit: minorFlagRateLimit,
  input: z.object({
    modelId,
    uphold: moderatorBoolean.describe('True upholds the flag, false overturns it.'),
  }),
  async handler(input, ctx) {
    await resolveMinorFlagAppeal({
      modelId: input.modelId,
      uphold: input.uphold,
      userId: ctx.actor.id,
    });
    return {
      resolved: input.uphold ? 'upheld' : 'overturned',
      modelId: input.modelId,
      affected: { modelIds: [input.modelId] },
    };
  },
});
