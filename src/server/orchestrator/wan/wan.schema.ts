import { WanVdeoGenInput } from '@civitai/client';
import z from 'zod';
import { AspectRatioMap, AspectRatio } from '~/libs/generation/utils/AspectRatio';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  seedSchema,
  textEnhancementSchema,
  imageEnhancementSchema,
  promptSchema,
  resourceSchema,
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
  duration: numberEnum(wanDuration).default(5).catch(5),
  seed: seedSchema,
  // draft: z.boolean().optional(),
  steps: z.number().default(20),
  resources: z.array(resourceSchema.passthrough()).default([]),
});

const wanTxt2VidSchema = textEnhancementSchema.merge(baseWanSchema).extend({
  aspectRatio: z.enum(wanAspectRatios).default('1:1').catch('1:1'),
});

const wanImg2VidSchema = imageEnhancementSchema
  .merge(baseWanSchema)
  .extend({ prompt: promptSchema });

const wanTxt2ImgConfig = new VideoGenerationConfig({
  subType: 'txt2vid',
  engine: 'wan',
  schema: wanTxt2VidSchema,
  metadataDisplayProps: ['cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
});

const wanImg2VidConfig = new VideoGenerationConfig({
  subType: 'img2vid',
  engine: 'wan',
  schema: wanImg2VidSchema,
  metadataDisplayProps: ['cfgScale', 'steps', 'duration', 'seed', 'sourceImage'],
});

export const wanVideoGenerationConfig = [wanTxt2ImgConfig, wanImg2VidConfig];

export function WanInput({
  resources,
  ...args
}: z.infer<(typeof wanVideoGenerationConfig)[number]['schema']>): WanVdeoGenInput {
  // const resolution = draft ? 420 : 640;
  // const resolution = 420;
  const hasSourceImage = 'sourceImage' in args;
  const sourceImage = hasSourceImage ? args.sourceImage.url : undefined;

  const ar = hasSourceImage
    ? AspectRatio.fromSize(args.sourceImage, {
        multiplier: 16,
      })
    : wanAspectRatioMap[args.aspectRatio];
  const { width, height } = ar.getSize2(480);
  // const { width, height } = hasSourceImage
  //   ? args.sourceImage
  //   : wanAspectRatioMap[args.aspectRatio].getSize(resolution);

  return {
    ...args,
    width,
    height,
    sourceImage,
    // duration: 5,
    loras: resources.map(({ air, strength }) => ({ air, strength })),
    // model: 'urn:air:wanvideo:checkpoint:civitai:1329096@1707796',
  };
}
