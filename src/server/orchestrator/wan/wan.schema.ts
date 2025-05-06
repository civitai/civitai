import { WanVdeoGenInput } from '@civitai/client';
import z from 'zod';
import { AspectRatioMap, AspectRatio } from '~/libs/generation/utils/AspectRatio';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  seedSchema,
  promptSchema,
  resourceSchema,
  baseGenerationSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const wanAspectRatios = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
export const wanDuration = [3, 5] as const;
export const wanAspectRatioMap = AspectRatioMap([...wanAspectRatios], { multiplier: 16 });

const wanSchema = baseGenerationSchema.extend({
  engine: z.literal('wan').catch('wan'),
  sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  aspectRatio: z.enum(wanAspectRatios).optional().catch('1:1'),
  cfgScale: z.number().min(1).max(10).optional().catch(4),
  frameRate: z.literal(16).optional().catch(16),
  duration: numberEnum(wanDuration).optional().catch(5),
  seed: seedSchema,
  resources: z.array(resourceSchema.passthrough()).default([]),
});

export const wanGenerationConfig = VideoGenerationConfig2({
  label: 'Wan',
  whatIfProps: [
    'duration',
    'steps',
    'aspectRatio',
    'cfgScale',
    'draft',
    'resources',
    'sourceImage',
  ],
  metadataDisplayProps: ['cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
  schema: wanSchema,
  defaultValues: { aspectRatio: '1:1', duration: 5, cfgScale: 4, frameRate: 16 },
  transformFn: (data) => {
    if (data.sourceImage) delete data.aspectRatio;
    return data;
  },
  superRefine: (data, ctx) => {
    if (!data.sourceImage && !data.prompt?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Prompt is required',
        path: ['prompt'],
      });
    }
  },
  inputFn: ({ sourceImage, resources, ...args }): WanVdeoGenInput => {
    const ar = sourceImage
      ? AspectRatio.fromSize(sourceImage, { multiplier: 16 })
      : wanAspectRatioMap[args.aspectRatio ?? '1:1'];
    const { width, height } = ar.getSize2(480);
    return {
      ...args,
      width,
      height,
      sourceImage: sourceImage?.url,
      steps: 20,
      loras: resources.map(({ air, strength }) => ({ air, strength })),
      // model: 'urn:air:wanvideo:checkpoint:civitai:1329096@1707796',
    };
  },
});
