import { ViduVideoGenInput, ViduVideoGenStyle } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  imageEnhancementSchema,
  negativePromptSchema,
  promptSchema,
  seedSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const viduDuration = [4, 8] as const;

const baseKlingSchema = z.object({
  engine: z.literal('vidu'),
  workflow: z.string(),
  enablePromptEnhancer: z.boolean().default(true),
  style: z.nativeEnum(ViduVideoGenStyle).catch(ViduVideoGenStyle.GENERAL),
  duration: numberEnum(viduDuration).default(4).catch(4),
  seed: seedSchema,
});

const viduTxt2VidSchema = textEnhancementSchema.merge(baseKlingSchema).extend({
  negativePrompt: negativePromptSchema,
});

const viduImg2VidSchema = imageEnhancementSchema
  .merge(baseKlingSchema)
  .extend({ prompt: promptSchema });

const viduTxt2ImgConfig = new VideoGenerationConfig({
  subType: 'txt2vid',
  engine: 'vidu',
  schema: viduTxt2VidSchema,
  metadataDisplayProps: ['style', 'duration', 'seed'],
});

const viduImg2VidConfig = new VideoGenerationConfig({
  subType: 'img2vid',
  engine: 'vidu',
  schema: viduImg2VidSchema,
  metadataDisplayProps: ['style', 'duration', 'seed'],
});

export const viduVideoGenerationConfig = [viduTxt2ImgConfig, viduImg2VidConfig];

export function ViduInput({
  ...args
}: z.infer<(typeof viduVideoGenerationConfig)[number]['schema']>): ViduVideoGenInput {
  const sourceImage = 'sourceImage' in args ? args.sourceImage.url : undefined;
  return { ...args, sourceImage };
}
