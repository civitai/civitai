import * as z from 'zod';
import { confirmMinorHashAutoFlag } from '~/server/services/minor-hash.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('minorFlag.confirm', {
  summary: 'Sign off an auto-flag.',
  returns: '{ confirmed }',
  notes: [
    "Promotes the snapshot to source='manual', which starts the model's hashes seeding future matches.",
  ],
  rateLimit: minorFlagRateLimit,
  input: z.object({ modelId }),
  async handler(input, ctx) {
    await confirmMinorHashAutoFlag({ modelId: input.modelId, userId: ctx.actor.id });
    return { confirmed: input.modelId, affected: { modelIds: [input.modelId] } };
  },
});
