import * as z from 'zod';
import {
  RATING_REVIEW_ENTITY_TYPES,
  type RatingReviewEntityType,
} from '@civitai/shared/rating-review';

export const ratingReviewEntityTypeSchema = z.enum(RATING_REVIEW_ENTITY_TYPES);

export type CreateRatingReviewInput = z.infer<typeof createRatingReviewSchema>;
export const createRatingReviewSchema = z.object({
  entityType: ratingReviewEntityTypeSchema,
  entityId: z.number().int().positive(),
  suggestedLevel: z.number().int().positive(),
  userComment: z.string().max(500).optional(),
});

export type GetMyRatingReviewInput = z.infer<typeof getMyRatingReviewSchema>;
export const getMyRatingReviewSchema = z.object({
  entityType: ratingReviewEntityTypeSchema,
  entityId: z.number().int().positive(),
});

export const ratingDisputeFeature = (entityType: RatingReviewEntityType) =>
  entityType === 'Article' ? ('articleRatingDispute' as const) : ('ratingDispute' as const);
