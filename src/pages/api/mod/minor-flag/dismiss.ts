import * as z from 'zod';
import { dismissMinorHashMatch } from '~/server/services/minor-hash.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('minorFlag.dismiss', {
  summary: 'Take a hash match off the review queue without flagging anything.',
  returns: '{ dismissed }',
  notes: ['Not a verdict on the model.'],
  rateLimit: minorFlagRateLimit,
  input: z.object({ modelId }),
  async handler(input, ctx) {
    await dismissMinorHashMatch({ modelId: input.modelId, userId: ctx.actor.id });
    return { dismissed: input.modelId, affected: { modelIds: [input.modelId] } };
  },
});
