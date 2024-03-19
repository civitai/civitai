import { defaultsDeep } from 'lodash';
import { z } from 'zod';

export type CreateTrainingRequestInput = z.infer<typeof createTrainingRequestSchema>;
export const createTrainingRequestSchema = z.object({
  modelVersionId: z.number(),
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

const trainingCostSchema = z.object({
  baseModelCoeff: z.number(),
  etaCoefficients: z.object({
    models: z.record(z.string(), z.number()),
    alpha: z.number(),
    dim: z.number(),
    steps: z.number(),
  }),
  stepsCoeff: z.number().min(1),
  stepsExp: z.number().min(1),
  hourlyCost: z.number().min(0),
  baseBuzz: z.number().min(0),
  customModelBuzz: z.number().min(0),
  minEta: z.number().min(1),
});
export type TrainingCost = z.infer<typeof trainingCostSchema>;
export const defaultTrainingCost: TrainingCost = {
  baseModelCoeff: 0,
  etaCoefficients: {
    models: {
      sdxl: 19.42979334,
      pony: 19.42979334,
      sd_1_5: -25.38624804,
      anime: -23.84022578,
      semi: -20.56343578,
      realistic: -50.28902011,
    },
    alpha: -0.649960841,
    dim: 0.792224422,
    steps: 0.014458002,
  },
  stepsCoeff: 2,
  stepsExp: 1.17,
  hourlyCost: 0.44,
  baseBuzz: 500,
  customModelBuzz: 500,
  minEta: 5,
};

export const trainingServiceStatusSchema = z.object({
  available: z.boolean().default(true),
  message: z.string().nullish(),
  cost: trainingCostSchema
    .partial()
    .optional()
    .transform((cost) => {
      return defaultsDeep(cost, defaultTrainingCost);
    }),
});
export type TrainingServiceStatus = z.infer<typeof trainingServiceStatusSchema>;
