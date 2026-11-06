import * as z from 'zod';
import { confirmPoiHashAutoFlag } from '~/server/services/poi-hash.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('poiFlag.confirm', {
  summary: 'Sign off a real-person flag the hash match applied.',
  returns: '{ confirmed }',
  notes: [
    "Promotes the snapshot to source='manual', which starts the model's hashes seeding future matches.",
    'Read `confirmed`: 0 means the model carries no hash-applied real-person flag.',
  ],
  rateLimit: minorFlagRateLimit,
  input: z.object({ modelId }),
  async handler(input, ctx) {
    const { confirmed } = await confirmPoiHashAutoFlag({
      modelId: input.modelId,
      userId: ctx.actor.id,
    });
    return { confirmed, affected: { modelIds: [input.modelId] } };
  },
});
