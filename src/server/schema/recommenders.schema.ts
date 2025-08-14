import * as z from 'zod';
import { baseQuerySchema } from '~/server/schema/base.schema';

export type RecommendationsResponse = z.infer<typeof recommendationsResponseSchema>;
export const recommendationsResponseSchema = z.array(z.number()).optional();

export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>;
export const recommendationRequestSchema = baseQuerySchema.extend({
  modelVersionId: z.number(),
  excludeIds: z.array(z.number()).optional(),
  limit: z.number().optional().default(5),
});
