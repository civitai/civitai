import * as z from 'zod';
import { createHomeBlockAdmin } from '~/server/services/home-block.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

export default defineModeratorEndpoint('homeblock.create', {
  summary: 'Create a home block.',
  returns: '{ id }',
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    type: z.nativeEnum(HomeBlockType).describe('Which kind of block to create.'),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Block configuration; shape depends on `type`.'),
    sourceId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe('The collection, announcement or event the block renders.'),
    index: z.coerce.number().int().optional().describe('Position on the home page.'),
    permanent: moderatorBoolean.optional().describe('Cannot be dismissed by users.'),
  }),
  async handler(input) {
    const homeBlock = await createHomeBlockAdmin({
      type: input.type,
      metadata: (input.metadata ?? {}) as never,
      sourceId: input.sourceId,
      index: input.index,
      permanent: input.permanent,
    });
    return { id: homeBlock.id, affected: { homeBlockIds: [homeBlock.id] } };
  },
});
