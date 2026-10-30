import * as z from 'zod';
import { setExcludeResourceReviews } from '~/server/services/resourceReview.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('review.setExclude', {
  summary: "Exclude reviews from a resource's rating, or put them back.",
  returns: '{ count }',
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    reviewIds: z
      .array(z.coerce.number().int().positive())
      .min(1)
      .max(500)
      .describe('Resource review ids to change.'),
    exclude: moderatorBoolean.describe('True to exclude from the rating, false to include again.'),
  }),
  async handler(input) {
    const { count } = await setExcludeResourceReviews({
      ids: input.reviewIds,
      exclude: input.exclude,
    });
    return { count, affected: { reviewIds: input.reviewIds } };
  },
});
