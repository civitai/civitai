import {
  ModelStatus,
  ModelType,
  ModelVersionMonetizationType,
  ModelVersionSponsorshipSettingsType,
  TrainingStatus,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { constants } from '~/server/common/constants';

import { imageSchema } from '~/server/schema/image.schema';
import { modelFileSchema } from '~/server/schema/model-file.schema';
import { ModelMeta } from '~/server/schema/model.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';

export type RecipeModelInput = z.infer<typeof recipeModelSchema>;
export const recipeModelSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  name: z.string(),
  type: z.enum(['version', 'result', 'unknown']),
});

export type RecipeInput = z.infer<typeof recipeSchema>;
export const recipeSchema = z.object({
  id: z.string().default(uuidv4()),
  type: z.enum(['sum', 'diff']),
  modelA: recipeModelSchema,
  modelB: recipeModelSchema,
  modelC: recipeModelSchema.optional(),
  multiplier: z.number(),
});

const trainingDetailsBaseModels15 = ['sd_1_5', 'anime', 'semi', 'realistic'] as const;
const trainingDetailsBaseModelsXL = ['sdxl', 'pony'] as const;
const trainingDetailsBaseModelCustom = z
  .string()
  .refine((value) => /^civitai:\d+@\d+$/.test(value ?? ''));
export type TrainingDetailsBaseModel15 = (typeof trainingDetailsBaseModels15)[number];
export type TrainingDetailsBaseModelXL = (typeof trainingDetailsBaseModelsXL)[number];
export type TrainingDetailsBaseModelCustom = z.infer<typeof trainingDetailsBaseModelCustom>;
const trainingDetailsBaseModels = [
  ...trainingDetailsBaseModels15,
  ...trainingDetailsBaseModelsXL,
] as const;
export type TrainingDetailsBaseModelList = (typeof trainingDetailsBaseModels)[number];
export type TrainingDetailsBaseModel =
  | TrainingDetailsBaseModelList
  | TrainingDetailsBaseModelCustom;

export type TrainingDetailsParams = z.infer<typeof trainingDetailsParams>;
export const trainingDetailsParams = z.object({
  unetLR: z.number(),
  textEncoderLR: z.number(),
  optimizerType: z.string(), // TODO actually an enum
  networkDim: z.number(),
  networkAlpha: z.number(),
  lrScheduler: z.string(), // TODO actually an enum
  maxTrainEpochs: z.number(),
  numRepeats: z.number(),
  resolution: z.number(),
  loraType: z.string(), // TODO actually an enum
  enableBucket: z.boolean(),
  keepTokens: z.number(),

  // nb: these 3 are not actually optional, but because we added them later, old versions will not have them causing the schema check to fail
  clipSkip: z.number().optional(),
  flipAugmentation: z.boolean().optional(),
  noiseOffset: z.number().optional(),

  lrSchedulerNumCycles: z.number(),
  trainBatchSize: z.number(),
  minSnrGamma: z.number(),
  optimizerArgs: z.string().optional(), // TODO remove
  shuffleCaption: z.boolean(),
  targetSteps: z.number(),
  // lrWarmupSteps: z.number(),
  // seed: null,
  // gradientAccumulationSteps: 1,
});

export type TrainingDetailsObj = z.infer<typeof trainingDetailsObj>;
export const trainingDetailsObj = z.object({
  baseModel: z
    .union([z.enum(trainingDetailsBaseModels), trainingDetailsBaseModelCustom])
    .optional(), // nb: this is not optional when submitting
  baseModelType: z.enum(['sd15', 'sdxl']).optional(),
  type: z.enum(constants.trainingModelTypes),
  // triggerWord: z.string().optional(),
  params: trainingDetailsParams.optional(),
  samplePrompts: z.array(z.string()).optional(),
  staging: z.boolean().optional(),
});

export const modelVersionUpsertSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  baseModel: z.enum(constants.baseModels),
  baseModelType: z.enum(constants.baseModelTypes).nullish(),
  description: getSanitizedStringSchema({
    allowedTags: ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'ul', 'ol', 'li', 'code', 'pre'],
    stripEmpty: true,
  }).nullish(),
  steps: z.number().min(0).nullish(),
  epochs: z.number().min(0).max(100000).nullish(),
  images: z
    .array(imageSchema)
    .min(1, 'At least one example image must be uploaded')
    .max(20, 'You can only upload up to 20 images'),
  trainedWords: z.array(z.string()),
  trainingStatus: z.nativeEnum(TrainingStatus).optional(),
  trainingDetails: trainingDetailsObj.optional(),
  files: z.array(modelFileSchema),
  earlyAccessTimeFrame: z.number().min(0).max(14).optional(),
  // recipe: z.array(recipeSchema).optional(),
});

export type RecommendedSettingsSchema = z.infer<typeof recommendedSettingsSchema>;
export const recommendedSettingsSchema = z.object({
  minStrength: z.number().nullish(),
  maxStrength: z.number().nullish(),
  strength: z.number().nullish(),
});

export type RecommendedResourceSchema = z.infer<typeof recommendedResourceSchema>;
const recommendedResourceSchema = z.object({
  id: z.number().optional(),
  resourceId: z.number(),
  settings: recommendedSettingsSchema.optional(),
});

export type ModelVersionUpsertInput = z.infer<typeof modelVersionUpsertSchema2>;
export const modelVersionUpsertSchema2 = z.object({
  modelId: z.number(),
  id: z.number().optional(),
  name: z.string().trim().min(1, 'Name cannot be empty.'),
  baseModel: z.enum(constants.baseModels),
  baseModelType: z.enum(constants.baseModelTypes).nullish(),
  description: getSanitizedStringSchema({
    allowedTags: ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'ul', 'ol', 'li', 'code', 'pre'],
    stripEmpty: true,
  }).nullish(),
  steps: z.number().min(0).nullish(),
  epochs: z.number().min(0).max(100000).nullish(),
  clipSkip: z.number().min(1).max(12).nullish(),
  vaeId: z.number().nullish(),
  trainedWords: z.array(z.string()).default([]),
  trainingStatus: z.nativeEnum(TrainingStatus).nullish(),
  trainingDetails: trainingDetailsObj.nullish(),
  earlyAccessTimeFrame: z.preprocess(
    (value) => (value ? Number(value) : 0),
    z.number().min(0).max(14).optional()
  ),
  status: z.nativeEnum(ModelStatus).optional(),
  requireAuth: z.boolean().optional(),
  monetization: z
    .object({
      id: z.number().nullish(),
      type: z.nativeEnum(ModelVersionMonetizationType).nullish(),
      unitAmount: z.number().nullish(),
      sponsorshipSettings: z
        .object({
          type: z.nativeEnum(ModelVersionSponsorshipSettingsType),
          unitAmount: z.number().min(0),
        })
        .nullish(),
    })
    .nullish(),
  settings: recommendedSettingsSchema.nullish(),
  recommendedResources: z.array(recommendedResourceSchema).optional(),
  templateId: z.number().optional(),
  bountyId: z.number().optional(),
});

export type GetModelVersionSchema = z.infer<typeof getModelVersionSchema>;
export const getModelVersionSchema = z.object({
  id: z.number(),
  withFiles: z.boolean().optional(),
});

export type UpsertExplorationPromptInput = z.infer<typeof upsertExplorationPromptSchema>;
export const upsertExplorationPromptSchema = z.object({
  // This is the modelVersionId
  id: z.number(),
  // Including modelId to confirm ownership
  modelId: z.number().optional(),
  name: z.string().trim().min(1, 'Name cannot be empty.'),
  prompt: z.string().trim().min(1, 'Prompt cannot be empty.'),
  index: z.number().optional(),
});

export type DeleteExplorationPromptInput = z.infer<typeof deleteExplorationPromptSchema>;
export const deleteExplorationPromptSchema = z.object({
  id: z.number(),
  modelId: z.number().optional(),
  name: z.string().trim().min(1, 'Name cannot be empty.'),
});

export type ModelVersionMeta = ModelMeta & {
  picFinderModelId?: number;
  earlyAccessDownloadData?: { date: string; downloads: number }[];
  generationImagesCount?: { date: string; generations: number }[];
};

export type PublishVersionInput = z.infer<typeof publishVersionSchema>;
export const publishVersionSchema = z.object({
  id: z.number(),
  publishedAt: z.date().optional(),
});

export type GetModelVersionByModelTypeProps = z.infer<typeof getModelVersionByModelTypeSchema>;
export const getModelVersionByModelTypeSchema = z.object({
  type: z.nativeEnum(ModelType),
  query: z.string().optional(),
  baseModel: z.string().optional(),
  take: z.number().default(100),
});

export type ImageModelVersionDetail = z.infer<typeof imageModelVersionDetailSchema>;
export type CharacterModelVersionDetail = z.infer<typeof characterModelVersionDetailSchema>;
export type TextModelVersionDetail = z.infer<typeof textModelVersionDetailSchema>;
export type AudioModelVersionDetail = z.infer<typeof audioModelVersionDetailSchema>;

export const imageModelVersionDetailSchema = z.object({
  trainedWords: z.string().array().default([]),
  steps: z.number().optional(),
  epochs: z.number().optional(),
  baseModel: z.string(),
  //modelversion recommendations
  clipSkip: z.number().optional(),
  vaeId: z.number().optional(),
});
export const characterModelVersionDetailSchema = z.object({});
export const textModelVersionDetailSchema = z.object({});
export const audioModelVersionDetailSchema = z.object({});

export type EarlyAccessModelVersionsOnTimeframeSchema = z.infer<
  typeof earlyAccessModelVersionsOnTimeframeSchema
>;
export const earlyAccessModelVersionsOnTimeframeSchema = z.object({
  timeframe: z.number().optional(),
});

export type ModelVersionsGeneratedImagesOnTimeframeSchema = z.infer<
  typeof modelVersionsGeneratedImagesOnTimeframeSchema
>;
export const modelVersionsGeneratedImagesOnTimeframeSchema = z.object({
  timeframe: z.number().optional(),
});
