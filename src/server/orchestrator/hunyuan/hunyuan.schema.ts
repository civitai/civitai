import { HunyuanVdeoGenInput } from '@civitai/client';
import z from 'zod';
import { AspectRatioMap } from '~/libs/generation/utils/AspectRatio';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  resourceSchema,
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
  cfgScale: z.number().min(1).max(10).default(6).catch(6),
  frameRate: z.literal(24).default(24).catch(24),
  duration: numberEnum(hunyuanDuration).default(5).catch(5),
  seed: seedSchema,
  draft: z.boolean().optional(),
  steps: z.number().default(20),
  model: z.string().optional(),
  resources: z.array(resourceSchema.passthrough()).default([]),
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
  resources,
  draft,
  ...args
}: z.infer<(typeof hunyuanVideoGenerationConfig)[number]['schema']>): HunyuanVdeoGenInput {
  const resolution = draft ? 420 : 640;
  // const resolution = 420;
  const { width, height } = hunyuanAspectRatioMap[aspectRatio].getSize(resolution);
  return {
    ...args,
    width,
    height,
    model: 'urn:air:hyv1:checkpoint:civitai:1167575@1314512',
    loras: resources.map(({ air, strength }) => ({ air, strength })),
  };
}
