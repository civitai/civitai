import { z } from 'zod';
import { baseQuerySchema } from '~/server/schema/base.schema';

export namespace Recommenders {
  export const RecommendationResponseSchema = z.array(z.number()).optional();
  export type RecommendationRequest = z.infer<typeof RecommendationRequestSchema>;
  export const RecommendationRequestSchema = baseQuerySchema.extend({
    modelVersionId: z.number(),
    excludeIds: z.array(z.number()).optional(),
  });
}
