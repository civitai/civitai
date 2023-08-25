import { ModelStatus, ModelType, TrainingStatus } from '@prisma/client';
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

export const trainingDetailsBaseModels = ['sd_1_5', 'sdxl', 'anime', 'semi', 'realistic'] as const;
export type TrainingDetailsBaseModel = (typeof trainingDetailsBaseModels)[number];

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
  lrSchedulerNumCycles: z.number(),
  trainBatchSize: z.number(),
  minSnrGamma: z.number(),
  optimizerArgs: z.string(),
  shuffleCaption: z.boolean(),
  targetSteps: z.number(),
  // lrWarmupSteps: z.number(),
  // clipSkip: 2,
  // seed: null,
  // gradientAccumulationSteps: 1,
});

export type TrainingDetailsObj = z.infer<typeof trainingDetailsObj>;
export const trainingDetailsObj = z.object({
  baseModel: z.enum(trainingDetailsBaseModels).optional(), // nb: this is not optional when submitting
  type: z.enum(constants.trainingModelTypes),
  // triggerWord: z.string().optional(),
  // samplePrompts
  params: trainingDetailsParams.optional(),
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
  earlyAccessTimeFrame: z.number().min(0).max(5).optional(),
  // recipe: z.array(recipeSchema).optional(),
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
    z.number().min(0).max(5).optional()
  ),
  status: z.nativeEnum(ModelStatus).optional(),
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

export type ModelVersionMeta = ModelMeta & { picFinderModelId?: number };

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
