import { TRPCError } from '@trpc/server';
import type { RatingReviewEntityType } from '@civitai/shared/rating-review';
import type { Context } from '~/server/createContext';
import {
  createRatingReviewSchema,
  getMyRatingReviewSchema,
  ratingDisputeFeature,
} from '~/server/schema/rating-review.schema';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import {
  createRatingReview,
  getRatingReviewForOwner,
} from '~/server/services/rating-review.service';
import { protectedProcedure, router } from '~/server/trpc';

function assertDisputeEnabled(ctx: Context, entityType: RatingReviewEntityType) {
  if (!getFeatureFlags(ctx)[ratingDisputeFeature(entityType)])
    throw new TRPCError({ code: 'FORBIDDEN' });
}

export const ratingReviewRouter = router({
  create: protectedProcedure.input(createRatingReviewSchema).mutation(async ({ input, ctx }) => {
    assertDisputeEnabled(ctx, input.entityType);
    const review = await createRatingReview({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
    // The ClickHouse table is Article-shaped and owned outside this repo.
    if (review.entityType === 'Article')
      ctx.track
        .articleRatingReview({
          articleId: review.entityId,
          fromLevel: review.currentLevel,
          toLevel: review.suggestedLevel,
          hasComment: !!review.userComment,
        })
        .catch(() => undefined);
    return review;
  }),
  getMine: protectedProcedure.input(getMyRatingReviewSchema).query(({ input, ctx }) => {
    assertDisputeEnabled(ctx, input.entityType);
    return getRatingReviewForOwner({ ...input, userId: ctx.user.id });
  }),
});
