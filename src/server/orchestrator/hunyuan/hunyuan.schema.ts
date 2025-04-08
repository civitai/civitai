import { HunyuanVdeoGenInput } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  seedSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { getScaledWidthHeight } from '~/shared/constants/generation.constants';
import { numberEnum } from '~/utils/zod-helpers';

export const hunyuanAspectRatios = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
export const hunyuanDuration = [3, 5] as const;

const hunyuanAspectRatioMap: Record<
  (typeof hunyuanAspectRatios)[number],
  { width: number; height: number }
> = {
  '16:9': { width: 1024, height: 576 },
  '3:2': { width: 960, height: 640 },
  '1:1': { width: 768, height: 768 },
  '2:3': { width: 640, height: 960 },
  '9:16': { width: 576, height: 1024 },
};

// {
//   '16:9': { width: 720, height: 768 },
//   '4:3': { width: 720, height: 960 },
//   '1:1': { width: 720, height: 720 },
//   '3:4': { width: 960, height: 720 },
//   '9:16': { width: 768, height: 720 },
// };

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
  const size = hunyuanAspectRatioMap[aspectRatio];
  const { width, height } = draft ? getScaledWidthHeight(size.width, size.height, 0.5) : size;
  return { ...args, width, height };
}
