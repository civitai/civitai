import * as z from 'zod';
import { unassignCosmetic } from '~/server/services/cosmetic.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { cosmeticId, userIds } from '~/server/schema/moderator/cosmetic';

export default defineModeratorEndpoint('cosmetic.unassign', {
  summary: 'Take a cosmetic back from specific accounts.',
  returns: '{ count }',
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    cosmeticId: cosmeticId.describe('The cosmetic to remove.'),
    userIds: userIds.describe('Accounts to remove it from.'),
  }),
  async handler(input) {
    const { count } = await unassignCosmetic({
      cosmeticId: input.cosmeticId,
      userIds: input.userIds,
    });
    return { count, affected: { cosmeticIds: [input.cosmeticId], userIds: input.userIds } };
  },
});
