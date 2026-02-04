import type { SessionUser } from 'next-auth';
import * as z from 'zod';
import { OrchEngineTypes, OrchPriorityTypes } from '~/server/common/enums';
import {
  trainingDetailsParams,
  trainingDetailsParamsUnion,
} from '~/server/schema/model-version.schema';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';

const imageTrainingBaseSchema = z.object({
  model: z.string(),
  priority: z.enum(OrchPriorityTypes), // technically can be a number
  engine: z.enum(OrchEngineTypes),
  trainingDataImagesCount: z.number(),
});

// AI Toolkit specific parameters - uses discriminated union for proper modelVariant validation
const aiToolkitMaxEpochs = 40;
const aiToolkitBaseParams = z.object({
  engine: z.literal(OrchEngineTypes.AiToolkit),
  epochs: z.number().max(aiToolkitMaxEpochs),
  resolution: z.number().nullable(),
  lr: z.number(),
  textEncoderLr: z.number().nullable(),
  trainTextEncoder: z.boolean(),
  lrScheduler: z.enum(['constant', 'constant_with_warmup', 'cosine', 'linear', 'step']),
  optimizerType: z.enum([
    'adam',
    'adamw',
    'adamw8bit',
    'adam8bit',
    'lion',
    'lion8bit',
    'adafactor',
    'adagrad',
    'prodigy',
    'prodigy8bit',
  ]),
  networkDim: z.number().nullable(),
  networkAlpha: z.number().nullable(),
  noiseOffset: z.number().nullable(),
  minSnrGamma: z.number().nullable(),
  flipAugmentation: z.boolean(),
  shuffleTokens: z.boolean(),
  keepTokens: z.number(),
});

// Use discriminated union to enforce modelVariant requirements per ecosystem
const aiToolkitTrainingParams = z.discriminatedUnion('ecosystem', [
  // SD1, SDXL, Chroma, Qwen, and ZImageTurbo don't need modelVariant
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('sd1'),
    modelVariant: z.undefined().optional(),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('sdxl'),
    modelVariant: z.undefined().optional(),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('chroma'),
    modelVariant: z.undefined().optional(),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('qwen'),
    modelVariant: z.undefined().optional(),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('zimageturbo'),
    modelVariant: z.undefined().optional(),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('zimagebase'),
    modelVariant: z.undefined().optional(),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('ltx2'),
    modelVariant: z.undefined().optional(),
  }),
  // SD3, Flux1, Flux2Klein, and Wan require modelVariant
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('sd3'),
    modelVariant: z.enum(['large', 'medium']),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('flux1'),
    modelVariant: z.enum(['dev', 'schnell']),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('wan'),
    modelVariant: z.enum(['2.1', '2.2']),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('flux2klein'),
    modelVariant: z.enum(['4b', '9b']),
  }),
]);

export type AiToolkitTrainingParams = z.infer<typeof aiToolkitTrainingParams>;

const whatIfTrainingDetailsParams = trainingDetailsParams.pick({
  resolution: true,
  maxTrainEpochs: true,
  numRepeats: true,
  trainBatchSize: true,
});

// WhatIf schema that accepts either Kohya-style or AI Toolkit parameters
// Using discriminated union for better type safety based on engine type
const whatIfKohyaParams = z.object({
  model: z.string(),
  priority: z.enum(OrchPriorityTypes),
  engine: z.enum([
    OrchEngineTypes.Kohya,
    OrchEngineTypes.Rapid,
    OrchEngineTypes.Flux2Dev,
    OrchEngineTypes.Flux2DevEdit,
    OrchEngineTypes.Musubi,
  ]),
  trainingDataImagesCount: z.number(),
  resolution: z.number(),
  maxTrainEpochs: z.number(),
  numRepeats: z.number(),
  trainBatchSize: z.number(),
});

const whatIfAiToolkitParams = z.object({
  model: z.string(),
  priority: z.enum(OrchPriorityTypes),
  engine: z.literal(OrchEngineTypes.AiToolkit),
  trainingDataImagesCount: z.number(),
  ecosystem: z.string(),
  modelVariant: z.string().optional(),
  epochs: z.number().max(aiToolkitMaxEpochs),
  resolution: z.number().nullable(),
  lr: z.number(),
  textEncoderLr: z.number().nullable(),
  trainTextEncoder: z.boolean(),
  lrScheduler: z.enum(['constant', 'constant_with_warmup', 'cosine', 'linear', 'step']),
  optimizerType: z.enum([
    'adam',
    'adamw',
    'adamw8bit',
    'adam8bit',
    'lion',
    'lion8bit',
    'adafactor',
    'adagrad',
    'prodigy',
    'prodigy8bit',
  ]),
  networkDim: z.number().nullable(),
  networkAlpha: z.number().nullable(),
  noiseOffset: z.number().nullable(),
  minSnrGamma: z.number().nullable(),
  flipAugmentation: z.boolean(),
  shuffleTokens: z.boolean(),
  keepTokens: z.number(),
  maxTrainEpochs: z.number().nullable().optional(),
});

export const imageTrainingRouterWhatIfSchema = z.discriminatedUnion('engine', [
  whatIfKohyaParams,
  whatIfAiToolkitParams,
]);
export type ImageTrainingRouterWhatIfSchema = z.infer<typeof imageTrainingRouterWhatIfSchema>;

const imageTrainingStepSchema = imageTrainingBaseSchema.extend({
  trainingData: z.url(),
  loraName: z.string(),
  samplePrompts: z.array(z.string()),
  negativePrompt: z.string().optional(),
  params: z.discriminatedUnion('engine', [
    whatIfTrainingDetailsParams.extend({ engine: z.enum(OrchEngineTypes) }),
    trainingDetailsParamsUnion,
  ]),
  modelFileId: z.number(),
});
export type ImageTrainingStepSchema = z.infer<typeof imageTrainingStepSchema>;

export const imageTrainingRouterInputSchema = z.object({
  modelVersionId: z.number(),
});

const imageTrainingWorkflowSchema = imageTrainingRouterInputSchema.extend({
  token: z.string(),
  currencies: z.array(z.enum(buzzSpendTypes)).optional(),
});
export type ImageTrainingWorkflowSchema = z.infer<typeof imageTrainingWorkflowSchema> & {
  user: SessionUser;
};

// Can't extend a union, so we need to merge with an intersection
const imageTraininWhatIfgWorkflowSchema = z.intersection(
  imageTrainingRouterWhatIfSchema,
  z.object({
    token: z.string(),
    currencies: z.array(z.enum(buzzSpendTypes)).optional(),
  })
);
export type ImageTraininWhatIfWorkflowSchema = z.infer<typeof imageTraininWhatIfgWorkflowSchema>;
