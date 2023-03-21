import { z } from 'zod';

export type GetResourceReviewsInput = z.infer<typeof getResourceReviewsSchema>;
export const getResourceReviewsSchema = z.object({
  resourceIds: z.number().array(),
});

export type UpsertResourceReviewInput = z.infer<typeof upsertResourceReviewSchema>;
export const upsertResourceReviewSchema = z.object({
  id: z.number().optional(),
  modelVersionId: z.number(),
  rating: z.number(),
  details: z.string().optional(),
});
