import type { SessionUser } from 'next-auth';
import * as z from 'zod';
import { OrchEngineTypes, OrchPriorityTypes } from '~/server/common/enums';
import { trainingDetailsParams } from '~/server/schema/model-version.schema';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';

const imageTrainingBaseSchema = z.object({
  model: z.string(),
  priority: z.enum(OrchPriorityTypes), // technically can be a number
  engine: z.enum(OrchEngineTypes),
  trainingDataImagesCount: z.number(),
});

// AI Toolkit specific parameters - uses discriminated union for proper modelVariant validation
const aiToolkitBaseParams = z.object({
  engine: z.literal(OrchEngineTypes.AiToolkit),
  epochs: z.number(),
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
  // SD1 and SDXL don't need modelVariant
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('sd1'),
    modelVariant: z.undefined().optional(),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('sdxl'),
    modelVariant: z.undefined().optional(),
  }),
  // SD3, Flux1, and Wan require modelVariant
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
    ecosystem: z.literal('chroma'),
    modelVariant: z.undefined().optional(),
  }),
]);

export type AiToolkitTrainingParams = z.infer<typeof aiToolkitTrainingParams>;

const whatIfTrainingDetailsParams = trainingDetailsParams.pick({
  resolution: true,
  maxTrainEpochs: true,
  numRepeats: true,
  trainBatchSize: true,
});

export const imageTrainingRouterWhatIfSchema = imageTrainingBaseSchema.merge(
  whatIfTrainingDetailsParams
);
export type ImageTrainingRouterWhatIfSchema = z.infer<typeof imageTrainingRouterWhatIfSchema>;

const imageTrainingStepSchema = imageTrainingBaseSchema.extend({
  trainingData: z.url(),
  loraName: z.string(),
  samplePrompts: z.array(z.string()),
  negativePrompt: z.string().optional(),
  params: z.union([
    trainingDetailsParams.extend({ engine: z.enum(OrchEngineTypes) }),
    whatIfTrainingDetailsParams.extend({ engine: z.enum(OrchEngineTypes) }),
    aiToolkitTrainingParams,
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

const imageTraininWhatIfgWorkflowSchema = imageTrainingRouterWhatIfSchema.extend({
  token: z.string(),
  currencies: z.array(z.enum(buzzSpendTypes)).optional(),
});
export type ImageTraininWhatIfWorkflowSchema = z.infer<typeof imageTraininWhatIfgWorkflowSchema>;
