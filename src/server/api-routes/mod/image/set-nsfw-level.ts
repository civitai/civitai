import * as z from 'zod';
import { updateImageNsfwLevel } from '~/server/services/image.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { imageId, nsfwLevel } from '~/server/schema/moderator/image';

export default defineModeratorEndpoint('image.setNsfwLevel', {
  summary: 'Set the rating on images, and lock it against further automatic change.',
  returns: '{ count }',
  notes: [
    'Each item writes the Image row with `nsfwLevelLocked = true` and upserts a `setNsfwLevel` ModActivity row.',
    'The deprecated `research_ratings` insert the original Retool query did is deliberately not carried over — Knights of New Order replaced that data source.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    items: z
      .array(z.object({ imageId, nsfwLevel }))
      .min(1)
      .max(500)
      .describe('Image id and the rating to set on it.'),
  }),
  async handler(input, ctx) {
    const imageIds: number[] = [];
    for (const item of input.items) {
      await updateImageNsfwLevel({
        id: item.imageId,
        nsfwLevel: item.nsfwLevel,
        userId: ctx.actor.id,
        isModerator: true,
      });
      imageIds.push(item.imageId);
    }
    return { count: imageIds.length, affected: { imageIds } };
  },
});
