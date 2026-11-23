import * as z from 'zod';
import { refreshAfterHoldingsRemoved } from '~/server/services/cosmetic.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { cosmeticId } from '~/server/schema/moderator/cosmetic';
import { CosmeticEntity } from '~/shared/utils/prisma/enums';

const id = z.coerce.number().int().positive();

export default defineModeratorEndpoint('cosmetic.holdingsRemoved', {
  summary: 'Refresh what shows a cosmetic after its holdings were deleted elsewhere.',
  returns: '{ refreshed }',
  notes: [
    'For a caller that deleted equipped `UserCosmetic` rows itself (the moderator app). ' +
      'The rows only name what to re-derive: an entity whose cosmetic is still equipped keeps it.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    removed: z
      .array(
        z.object({
          userId: id,
          cosmeticId,
          equippedToId: id,
          equippedToType: z.nativeEnum(CosmeticEntity),
        })
      )
      .min(1)
      .max(100)
      .describe('The deleted holdings that were equipped, and what they were equipped to.'),
  }),
  async handler({ removed }) {
    await refreshAfterHoldingsRemoved(removed);
    return {
      refreshed: removed.length,
      affected: {
        cosmeticIds: [...new Set(removed.map((r) => r.cosmeticId))],
        userIds: [...new Set(removed.map((r) => r.userId))],
      },
    };
  },
});
