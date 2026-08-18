import * as z from 'zod';
import { setModelMinor } from '~/server/services/model.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('minorFlag.setMinor', {
  summary: 'Flag a hash match as depicting a minor.',
  returns: '{ flagged }',
  notes: ['Carries the search index, the caches and the per-image propagation.'],
  rateLimit: minorFlagRateLimit,
  input: z.object({ modelId }),
  async handler(input, ctx) {
    await setModelMinor({ id: input.modelId, minor: true, userId: ctx.actor.id });
    return { flagged: input.modelId, affected: { modelIds: [input.modelId] } };
  },
});
