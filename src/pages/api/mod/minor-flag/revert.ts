import * as z from 'zod';
import { revertMinorHashAutoFlag } from '~/server/services/minor-hash.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('minorFlag.revert', {
  summary: 'Undo the flag and restore the pre-flag state.',
  returns: '{ reverted, failed, candidates }',
  // The 200 is not the outcome. A model whose snapshot capture failed has nothing to restore and
  // reverts as candidates 0 / reverted 0, with the flag still on.
  notes: [
    'Read `reverted`, not the status: 0 means nothing was restored and the flag still stands.',
  ],
  rateLimit: minorFlagRateLimit,
  input: z.object({ modelId }),
  async handler(input, ctx) {
    const report = await revertMinorHashAutoFlag({ modelId: input.modelId, userId: ctx.actor.id });
    return {
      reverted: report.rolledBack,
      failed: report.failed,
      candidates: report.candidates,
      affected: { modelIds: [input.modelId] },
    };
  },
});
