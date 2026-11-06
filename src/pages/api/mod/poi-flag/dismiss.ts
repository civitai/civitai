import * as z from 'zod';
import { dismissPoiHashMatch } from '~/server/services/poi-hash.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('poiFlag.dismiss', {
  summary: 'Take a real-person hash match off the review queue without flagging anything.',
  returns: '{ dismissed }',
  notes: [
    'Not a verdict on the model. Files already uploaded stop matching; a later upload can match again.',
    'Read `dismissed`: 0 means the model was not waiting in the queue.',
  ],
  rateLimit: minorFlagRateLimit,
  input: z.object({ modelId }),
  async handler(input, ctx) {
    const { dismissed } = await dismissPoiHashMatch({
      modelId: input.modelId,
      userId: ctx.actor.id,
    });
    return { dismissed, affected: { modelIds: [input.modelId] } };
  },
});
