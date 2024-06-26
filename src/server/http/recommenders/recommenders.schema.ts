import { z } from 'zod';

export namespace Recommenders {
  export const RecommendationResponseSchema = z.array(z.number()).optional()
  export type RecommendationRequest = z.infer<typeof RecommendationRequestSchema>;
  export const RecommendationRequestSchema = z.object({
    modelVersionId:z.number(),
    excludeIds: z.array(z.number()).optional()
  });

}
