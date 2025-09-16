import * as z from 'zod';
import { blockedCustomModels } from '~/components/Training/Form/TrainingCommon';
import { autoCaptionSchema } from '~/store/training.store';

/**
 * @deprecated for orchestrator v2
 */
export const createTrainingRequestSchema = z.object({
  modelVersionId: z.number(),
});

/**
 * @deprecated for orchestrator v2
 */
export const createTrainingRequestDryRunSchema = z.object({
  baseModel: z.string().nullable(),
  isPriority: z.boolean().optional(),
  // cost: z.number().optional(),
});

export type MoveAssetInput = z.infer<typeof moveAssetInput>;
export const moveAssetInput = z.object({
  url: z.url(),
  modelVersionId: z.number().positive(),
});

export type AutoTagInput = z.infer<typeof autoTagInput>;
export const autoTagInput = z.object({
  url: z.url(),
  modelId: z.number().positive(),
});
export type AutoCaptionInput = z.infer<typeof autoCaptionInput>;
export const autoCaptionInput = autoTagInput.merge(autoCaptionSchema.omit({ overwrite: true }));

export const trainingServiceStatusSchema = z.object({
  available: z.boolean().default(true),
  message: z.string().nullish(),
  blockedModels: z.array(z.string()).optional().default(blockedCustomModels),
});
export type TrainingServiceStatus = z.infer<typeof trainingServiceStatusSchema>;
