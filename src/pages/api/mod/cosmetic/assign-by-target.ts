import * as z from 'zod';
import { assignCosmeticByTarget } from '~/server/services/cosmetic.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { cosmeticId, userIds } from '~/server/schema/moderator/cosmetic';

export default defineModeratorEndpoint('cosmetic.assignByTarget', {
  summary: 'Grant a cosmetic to everyone matching a target.',
  returns: '{ granted, userCount, dryRun }',
  notes: ['Send `dryRun` first — it reports who would be granted without writing anything.'],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: z.object({
    cosmeticId: cosmeticId.describe('The cosmetic to grant.'),
    target: z
      .discriminatedUnion('type', [
        z.object({
          type: z.literal('collection'),
          collectionId: z.coerce.number().int().positive(),
          requireApproved: moderatorBoolean.optional(),
        }),
        z.object({ type: z.literal('userIds'), userIds }),
      ])
      .describe('Either a collection’s contributors, or an explicit list of user ids.'),
    dryRun: moderatorBoolean.optional().describe('Report the outcome without granting.'),
  }),
  async handler(input) {
    const result = await assignCosmeticByTarget({
      cosmeticId: input.cosmeticId,
      target: input.target,
      dryRun: input.dryRun,
    });
    return {
      granted: result.granted,
      userCount: result.userIds.length,
      dryRun: result.dryRun,
      affected: { cosmeticIds: [input.cosmeticId], userIds: result.userIds },
    };
  },
});
