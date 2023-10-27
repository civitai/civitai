import { z } from 'zod';

export type CreateTrainingRequestInput = z.infer<typeof createTrainingRequestSchema>;
export const createTrainingRequestSchema = z.object({
  modelVersionId: z.number(),
});

export type MoveAssetInput = z.infer<typeof moveAssetInput>;
export const moveAssetInput = z.object({
  url: z.string().url(),
  modelId: z.number().positive(),
});
