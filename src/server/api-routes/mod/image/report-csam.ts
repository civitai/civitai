import * as z from 'zod';
import { reportCsamImages } from '~/server/services/image.service';
import { imageId } from '~/server/schema/moderator/image';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('image.reportCsam', {
  summary: 'Put images in the CSAM review queue.',
  returns: '{ held }',
  notes: [
    'The same action as `image.reportCsamImages`: it flags the images for CSAM review and files no external report.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    imageIds: z.array(imageId).min(1).max(100).describe('The images to hold.'),
    scanLabelVoterId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe('Audit only: the moderator whose Scan Labels vote asked for the hold.'),
  }),
  async handler(input, ctx) {
    await reportCsamImages({
      imageIds: input.imageIds,
      user: ctx.actor,
      ip: resolveClientIpOrNull(ctx.req) ?? undefined,
    });
    return { held: input.imageIds, affected: { imageIds: input.imageIds } };
  },
});
