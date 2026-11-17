import * as z from 'zod';
import { revertPoiHashAutoFlag } from '~/server/services/poi-hash.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('poiFlag.revert', {
  summary: 'Undo a real-person flag the hash match applied, restoring the pre-flag state.',
  returns: '{ reverted }',
  notes: [
    'Read `reverted`, not the status: 0 means the model carries no hash-applied flag, and nothing changed.',
  ],
  rateLimit: minorFlagRateLimit,
  input: z.object({ modelId }),
  async handler(input, ctx) {
    const { reverted } = await revertPoiHashAutoFlag({
      modelId: input.modelId,
      userId: ctx.actor.id,
    });
    return { reverted, affected: { modelIds: [input.modelId] } };
  },
});
