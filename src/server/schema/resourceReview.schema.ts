import { z } from 'zod';

export type GetResourceReviewsInput = z.infer<typeof getResourceReviewsSchema>;
export const getResourceReviewsSchema = z.object({
  resourceIds: z.number().array(),
});

export type GetRatingTotalsInput = z.infer<typeof getRatingTotalsSchema>;
export const getRatingTotalsSchema = z.object({
  modelVersionId: z.number(),
});

export type GetResourceReviewsInfiniteInput = z.infer<typeof getResourceReviewsInfinite>;
export const getResourceReviewsInfinite = z.object({
  limit: z.number().min(1).max(100).default(50),
  cursor: z.number().optional(),
  modelId: z.number().optional(),
  modelVersionId: z.number().optional(),
});

export type UpsertResourceReviewInput = z.infer<typeof upsertResourceReviewSchema>;
export const upsertResourceReviewSchema = z.object({
  id: z.number().optional(),
  modelId: z.number(),
  modelVersionId: z.number(),
  rating: z.number(),
  details: z.string().optional(),
});

export type UpdateResourceReviewInput = z.infer<typeof updateResourceReviewSchema>;
export const updateResourceReviewSchema = z.object({
  id: z.number(),
  rating: z.number().optional(),
  details: z.string().optional(),
});
