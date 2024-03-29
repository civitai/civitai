import { defaultsDeep } from 'lodash';
import { z } from 'zod';
import { blockedCustomModels } from '~/components/Training/Form/TrainingCommon';

export type CreateTrainingRequestInput = z.infer<typeof createTrainingRequestSchema>;
export const createTrainingRequestSchema = z.object({
  modelVersionId: z.number(),
});

export type CreateTrainingRequestDryRunInput = z.infer<typeof createTrainingRequestDryRunSchema>;
export const createTrainingRequestDryRunSchema = z.object({
  baseModel: z.string().nullable(),
  // cost: z.number().optional(),
});

export type MoveAssetInput = z.infer<typeof moveAssetInput>;
export const moveAssetInput = z.object({
  url: z.string().url(),
  modelVersionId: z.number().positive(),
  modelId: z.number().positive(),
});

export type AutoTagInput = z.infer<typeof autoTagInput>;
export const autoTagInput = z.object({
  url: z.string().url(),
  modelId: z.number().positive(),
});

const trainingEtaSchema = z.object({
  base: z.number(),
  steps: z.number().min(0),
  stepMultiplier: z.number().min(1),
  expStrength: z.number().min(0),
  expStart: z.number().min(1),
});
const trainingCostSchema = z.object({
  modelCoefficients: z.object({
    sd15: trainingEtaSchema,
    sdxl: trainingEtaSchema,
  }),
  hourlyCost: z.number().min(0),
  baseBuzz: z.number().min(0),
  customModelBuzz: z.number().min(0),
  minEta: z.number().min(1),
});
export type TrainingCost = z.infer<typeof trainingCostSchema>;
export const defaultTrainingCost: TrainingCost = {
  modelCoefficients: {
    sd15: {
      base: 5,
      steps: 0.012,
      stepMultiplier: 1.73,
      expStrength: 1.55,
      expStart: 3000,
    },
    sdxl: {
      base: 30,
      steps: 0.02,
      stepMultiplier: 1.73,
      expStrength: 1.1,
      expStart: 2200,
    },
  },
  hourlyCost: 0.44,
  baseBuzz: 500,
  customModelBuzz: 500,
  minEta: 5,
};

export const trainingServiceStatusSchema = z.object({
  available: z.boolean().default(true),
  message: z.string().nullish(),
  blockedModels: z.array(z.string()).optional().default(blockedCustomModels),
  cost: trainingCostSchema
    .partial()
    .optional()
    .transform((cost) => {
      return defaultsDeep(cost, defaultTrainingCost);
    }),
});
export type TrainingServiceStatus = z.infer<typeof trainingServiceStatusSchema>;
