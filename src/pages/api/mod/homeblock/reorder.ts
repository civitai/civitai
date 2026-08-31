import * as z from 'zod';
import { reorderHomeBlocksAdmin } from '~/server/services/home-block.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('homeblock.reorder', {
  summary: 'Set every home block’s position from its place in the list.',
  returns: '{ count }',
  rateLimit: { max: 30, windowSeconds: 60 },
  notes: ['Ids omitted from the list keep their current index.'],
  input: z.object({
    orderedIds: z
      .array(z.coerce.number().int().positive())
      .min(1)
      .max(200)
      .describe('Home block ids, in the order they should appear.'),
  }),
  async handler(input) {
    const { count } = await reorderHomeBlocksAdmin({ orderedIds: input.orderedIds });
    return { count, affected: { homeBlockIds: input.orderedIds } };
  },
});
