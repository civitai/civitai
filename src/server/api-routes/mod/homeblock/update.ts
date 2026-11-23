import * as z from 'zod';
import { updateHomeBlockAdmin } from '~/server/services/home-block.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

export default defineModeratorEndpoint('homeblock.update', {
  summary: 'Change an existing home block.',
  returns: '{ id }',
  notes: ['Omitted fields are left as they are; `null` clears `index` and `sourceId`.'],
  input: z.object({
    homeBlockId: z.coerce.number().int().positive().describe('The block to change.'),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Block configuration; shape depends on `type`.'),
    index: z.coerce.number().int().nullable().optional().describe('Position on the home page.'),
    permanent: moderatorBoolean.optional().describe('Cannot be dismissed by users.'),
    type: z.nativeEnum(HomeBlockType).optional().describe('Which kind of block this is.'),
    sourceId: z.coerce
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe('The collection, announcement or event the block renders.'),
  }),
  async handler(input) {
    const updated = await updateHomeBlockAdmin({
      id: input.homeBlockId,
      metadata: input.metadata as never,
      index: input.index,
      permanent: input.permanent,
      type: input.type,
      sourceId: input.sourceId,
    });
    return { id: updated.id, affected: { homeBlockIds: [updated.id] } };
  },
});
