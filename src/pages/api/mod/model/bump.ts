import * as z from 'zod';
import { bumpModel } from '~/server/services/model.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('model.bump', {
  summary: 'Push a model to the top of the Newest feed.',
  returns: '{ modelId, lastVersionAt }',
  notes: ['Sets `lastVersionAt` to now, and invalidates the feed, search and user-count caches.'],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    modelId: z.coerce.number().int().positive().describe('The model to bump.'),
  }),
  async handler(input) {
    const updated = await bumpModel({ id: input.modelId });
    return {
      modelId: updated.id,
      lastVersionAt: updated.lastVersionAt,
      affected: { modelIds: [updated.id] },
    };
  },
});
