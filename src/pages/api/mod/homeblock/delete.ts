import * as z from 'zod';
import { deleteHomeBlockAdmin } from '~/server/services/home-block.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('homeblock.delete', {
  summary: 'Remove a home block from the home page.',
  returns: '{ deleted: true }',
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    homeBlockId: z.coerce.number().int().positive().describe('The block to remove.'),
  }),
  async handler(input) {
    await deleteHomeBlockAdmin({ id: input.homeBlockId });
    return { deleted: true, affected: { homeBlockIds: [input.homeBlockId] } };
  },
});
