import { z } from 'zod';
import { baseQuerySchema } from '~/server/schema/base.schema';

export const recommendationResponseSchema = z.array(z.number()).optional();

export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>;
export const recommendationRequestSchema = baseQuerySchema.extend({
  modelVersionId: z.number(),
  excludeIds: z.array(z.number()).optional(),
});
