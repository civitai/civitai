import { WanVdeoGenInput } from '@civitai/client';
import z from 'zod';
import { AspectRatioMap } from '~/libs/generation/utils/AspectRatio';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  seedSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const wanAspectRatios = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
export const wanDuration = [3, 5] as const;
export const wanAspectRatioMap = AspectRatioMap([...wanAspectRatios], { multiplier: 16 });

const baseWanSchema = z.object({
  engine: z.literal('wan'),
  workflow: z.string(),
  cfgScale: z.number().min(1).max(10).default(4).catch(4),
  frameRate: z.literal(16).default(16).catch(16),
  duration: numberEnum(wanDuration).default(3).catch(3),
  seed: seedSchema,
  draft: z.boolean().optional(),
  steps: z.number().default(25),
});

const wanTxt2VidSchema = textEnhancementSchema.merge(baseWanSchema).extend({
  aspectRatio: z.enum(wanAspectRatios).default('1:1').catch('1:1'),
});

// const wanImg2VidSchema = imageEnhancementSchema
//   .merge(baseWanSchema)
//   .extend({ prompt: promptSchema });

const wanTxt2ImgConfig = new VideoGenerationConfig({
  subType: 'txt2vid',
  engine: 'wan',
  schema: wanTxt2VidSchema,
  metadataDisplayProps: ['cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
});

// const wanImg2VidConfig = new VideoGenerationConfig({
//   subType: 'img2vid',
//   engine: 'wan',
//   schema: wanImg2VidSchema,
//   metadataDisplayProps: ['cfgScale', 'mode', 'duration', 'seed'],
// });

export const wanVideoGenerationConfig = [wanTxt2ImgConfig];

export function WanInput({
  aspectRatio,
  draft,
  ...args
}: z.infer<(typeof wanVideoGenerationConfig)[number]['schema']>): WanVdeoGenInput {
  const resolution = draft ? 480 : 720;
  const { width, height } = wanAspectRatioMap[aspectRatio].getSize(resolution);
  return { ...args, width, height };
}
