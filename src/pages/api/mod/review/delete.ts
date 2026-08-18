import * as z from 'zod';
import { deleteResourceReviews } from '~/server/services/resourceReview.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('review.delete', {
  summary: 'Delete resource reviews in bulk.',
  returns: '{ count }',
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    reviewIds: z
      .array(z.coerce.number().int().positive())
      .min(1)
      .max(500)
      .describe('Resource review ids to delete.'),
  }),
  async handler(input) {
    const { count } = await deleteResourceReviews({ ids: input.reviewIds });
    return { count, affected: { reviewIds: input.reviewIds } };
  },
});
