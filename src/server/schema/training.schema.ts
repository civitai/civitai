import { defaultsDeep } from 'lodash-es';
import { z } from 'zod';
import { blockedCustomModels } from '~/components/Training/Form/TrainingCommon';
import { autoCaptionSchema } from '~/store/training.store';

export type CreateTrainingRequestInput = z.infer<typeof createTrainingRequestSchema>;
export const createTrainingRequestSchema = z.object({
  modelVersionId: z.number(),
});

export type CreateTrainingRequestDryRunInput = z.infer<typeof createTrainingRequestDryRunSchema>;
export const createTrainingRequestDryRunSchema = z.object({
  baseModel: z.string().nullable(),
  isPriority: z.boolean().optional(),
  // cost: z.number().optional(),
});

export type MoveAssetInput = z.infer<typeof moveAssetInput>;
export const moveAssetInput = z.object({
  url: z.string().url(),
  modelVersionId: z.number().positive(),
});

export type AutoTagInput = z.infer<typeof autoTagInput>;
export const autoTagInput = z.object({
  url: z.string().url(),
  modelId: z.number().positive(),
});
export type AutoCaptionInput = z.infer<typeof autoCaptionInput>;
export const autoCaptionInput = autoTagInput.merge(autoCaptionSchema.omit({ overwrite: true }));

const trainingEtaSchema = z.object({
  base: z.number(),
  steps: z.number().min(0),
  stepMultiplier: z.number().min(1),
  expStrength: z.number().min(0),
  expStart: z.number().min(1),
  resolutionBase: z.number().min(512),
});
const trainingCostSchema = z.object({
  modelCoefficients: z.object({
    sd15: trainingEtaSchema,
    sdxl: trainingEtaSchema,
    flux: trainingEtaSchema,
  }),
  hourlyCost: z.number().min(0),
  baseBuzz: z.number().min(0),
  customModelBuzz: z.number().min(0),
  fluxBuzz: z.number().min(0),
  priorityBuzz: z.number().min(0),
  priorityBuzzPct: z.number().min(0),
  minEta: z.number().min(1),
  rapid: z.object({
    baseBuzz: z.number().min(0),
    numImgBase: z.number().min(1),
    numImgStep: z.number().min(1),
    numImgBuzz: z.number().min(0),
    discountFactor: z.number().min(0).optional(), // a multiplier, so "0.8" is a 20% discount
    discountStart: z.string().optional(), // as date
    discountEnd: z.string().optional(), // as date
  }),
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
      resolutionBase: 512,
    },
    sdxl: {
      base: 30,
      steps: 0.02,
      stepMultiplier: 1.73,
      expStrength: 1.1,
      expStart: 2200,
      resolutionBase: 1024,
    },
    flux: {
      base: 25,
      steps: 0.017,
      stepMultiplier: 1.73,
      expStrength: 1.55,
      expStart: 3000,
      resolutionBase: 512,
    },
  },
  hourlyCost: 0.44,
  baseBuzz: 500,
  customModelBuzz: 500,
  fluxBuzz: 1500,
  priorityBuzz: 100,
  priorityBuzzPct: 0.1,
  minEta: 5,
  rapid: {
    baseBuzz: 4000,
    numImgBase: 200,
    numImgStep: 100,
    numImgBuzz: 500,
    discountFactor: 0.6, // multiplier, not "discount"
    discountStart: '2024-09-13T00:00:00Z',
    discountEnd: '2024-09-25T00:00:00Z',
  },
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
