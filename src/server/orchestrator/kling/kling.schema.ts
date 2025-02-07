import { KlingMode, KlingModel } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  imageEnhancementSchema,
  negativePromptSchema,
  promptSchema,
  seedSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';

export const klingAspectRatios = ['16:9', '1:1', '9:16'] as const;
export const klingDuration = ['5', '10'] as const;

const baseKlingSchema = z.object({
  engine: z.literal('kling'),
  workflow: z.string(),
  model: z.nativeEnum(KlingModel).default(KlingModel.V1_5).catch(KlingModel.V1_5),
  enablePromptEnhancer: z.boolean().default(true),
  mode: z.nativeEnum(KlingMode).catch(KlingMode.STANDARD),
  duration: z.enum(klingDuration).default('5').catch('5'),
  cfgScale: z.number().min(0.1).max(1).default(0.5).catch(0.5),
  seed: seedSchema,
});

const klingTxt2VidSchema = textEnhancementSchema.merge(baseKlingSchema).extend({
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(klingAspectRatios).default('1:1').catch('1:1'),
});

const klingImg2VidSchema = imageEnhancementSchema
  .merge(baseKlingSchema)
  .extend({ prompt: promptSchema });

const klingTxt2ImgConfig = new VideoGenerationConfig({
  subType: 'txt2vid',
  engine: 'kling',
  schema: klingTxt2VidSchema,
  metadataDisplayProps: ['cfgScale', 'mode', 'aspectRatio', 'duration', 'seed'],
});

const klingImg2VidConfig = new VideoGenerationConfig({
  subType: 'img2vid',
  engine: 'kling',
  schema: klingImg2VidSchema,
  metadataDisplayProps: ['cfgScale', 'mode', 'duration', 'seed'],
});

export const klingVideoGenerationConfig = [klingTxt2ImgConfig, klingImg2VidConfig];
