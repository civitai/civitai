import { z } from 'zod';

export type RecommendationsResponse = z.infer<typeof recommendationsResponseSchema>;
export const recommendationsResponseSchema = z.array(z.number()).optional();

export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>;
export const recommendationRequestSchema = z.object({
  modelVersionId: z.number(),
  excludeIds: z.array(z.number()).optional(),
  limit: z.number().optional().default(5),
});
