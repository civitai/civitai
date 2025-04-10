import { HunyuanVdeoGenInput } from '@civitai/client';
import z from 'zod';
import { AspectRatioMap } from '~/libs/generation/utils/AspectRatio';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  seedSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const hunyuanAspectRatios = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
export const hunyuanDuration = [3, 5] as const;

const hunyuanAspectRatioMap = AspectRatioMap([...hunyuanAspectRatios], { multiplier: 16 });

const baseHunyuanSchema = z.object({
  engine: z.literal('hunyuan'),
  workflow: z.string(),
  cfgScale: z.number().min(1).max(10).default(10).catch(10),
  frameRate: z.literal(24).default(24),
  duration: numberEnum(hunyuanDuration).default(3).catch(3),
  seed: seedSchema,
  draft: z.boolean().optional(),
  steps: z.number().default(25),
});

const hunyuanTxt2VidSchema = textEnhancementSchema.merge(baseHunyuanSchema).extend({
  aspectRatio: z.enum(hunyuanAspectRatios).default('1:1').catch('1:1'),
});

// const hunyuanImg2VidSchema = imageEnhancementSchema
//   .merge(baseHunyuanSchema)
//   .extend({ prompt: promptSchema });

const hunyuanTxt2ImgConfig = new VideoGenerationConfig({
  subType: 'txt2vid',
  engine: 'hunyuan',
  schema: hunyuanTxt2VidSchema,
  metadataDisplayProps: ['cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
});

// const hunyuanImg2VidConfig = new VideoGenerationConfig({
//   subType: 'img2vid',
//   engine: 'hunyuan',
//   schema: hunyuanImg2VidSchema,
//   metadataDisplayProps: ['cfgScale', 'mode', 'duration', 'seed'],
// });

export const hunyuanVideoGenerationConfig = [hunyuanTxt2ImgConfig];

export function HunyuanInput({
  aspectRatio,
  draft,
  ...args
}: z.infer<(typeof hunyuanVideoGenerationConfig)[number]['schema']>): HunyuanVdeoGenInput {
  const resolution = draft ? 480 : 720;
  const { width, height } = hunyuanAspectRatioMap[aspectRatio].getSize(resolution);
  return { ...args, width, height };
}
