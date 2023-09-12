import { z } from 'zod';

export type CreateTrainingRequestInput = z.infer<typeof createTrainingRequestSchema>;
export const createTrainingRequestSchema = z.object({
  modelVersionId: z.number(),
});
