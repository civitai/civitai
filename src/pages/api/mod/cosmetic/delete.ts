import * as z from 'zod';
import { deleteCosmetic } from '~/server/services/cosmetic.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { cosmeticId } from '~/server/schema/moderator/cosmetic';

export default defineModeratorEndpoint('cosmetic.delete', {
  summary: 'Delete a cosmetic.',
  returns: '{ deleted: true }',
  rateLimit: { max: 10, windowSeconds: 60 },
  input: z.object({ cosmeticId: cosmeticId.describe('The cosmetic to delete.') }),
  async handler(input) {
    await deleteCosmetic({ id: input.cosmeticId });
    return { deleted: true, affected: { cosmeticIds: [input.cosmeticId] } };
  },
});
