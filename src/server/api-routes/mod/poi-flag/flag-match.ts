import * as z from 'zod';
import { flagPoiHashMatch } from '~/server/services/poi-hash.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('poiFlag.flagMatch', {
  summary: 'Flag a model waiting on a real-person hash match as depicting a real person.',
  returns: '{ flagged }',
  notes: [
    'Applies what the model edit form does (`model/set-poi`), and takes the model off the match queue.',
    'Read `flagged`: 0 means the model was no longer waiting in the queue, so nothing was flagged.',
  ],
  rateLimit: minorFlagRateLimit,
  input: z.object({ modelId }),
  async handler(input, ctx) {
    const { flagged } = await flagPoiHashMatch({
      modelId: input.modelId,
      userId: ctx.actor.id,
      tracker: ctx.tracker,
    });
    return { flagged, affected: { modelIds: [input.modelId] } };
  },
});
