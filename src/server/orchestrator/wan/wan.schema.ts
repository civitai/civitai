import type { WanVdeoGenInput } from '@civitai/client';
import z from 'zod';
import { AspectRatioMap, AspectRatio } from '~/libs/generation/utils/AspectRatio';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  seedSchema,
  promptSchema,
  resourceSchema,
  baseVideoGenerationSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const wanAspectRatios = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
export const wanDuration = [3, 5] as const;
export const wanAspectRatioMap = AspectRatioMap([...wanAspectRatios], { multiplier: 16 });

export const wanBaseModelMap = {
  WanVideo1_3B_T2V: {
    process: 'txt2vid',
    label: 'Wan Video 1.3B t2v',
    model: 'urn:air:wanvideo1_3b_t2v:checkpoint:civitai:1329096@1500646',
    default: false,
  },
  WanVideo14B_T2V: {
    process: 'txt2vid',
    label: 'Wan Video 14B t2v',
    model: 'urn:air:wanvideo14b_t2v:checkpoint:civitai:1329096@1707796',
    default: true,
  },
  WanVideo14B_I2V_480p: {
    process: 'img2vid',
    label: 'Wan Video 14B i2v 480p',
    model: 'urn:air:wanvideo14b_i2v_480p:checkpoint:civitai:1329096@1501125',
    default: false,
  },
  WanVideo14B_I2V_720p: {
    process: 'img2vid',
    label: 'Wan Video 14B i2v 720p',
    model: 'urn:air:wanvideo14b_i2v_720p:checkpoint:civitai:1329096@1501344',
    default: true,
  },
};

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('wan').catch('wan'),
  baseModel: z.string().optional(),
  sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  aspectRatio: z.enum(wanAspectRatios).optional().catch('1:1'),
  cfgScale: z.number().min(1).max(10).optional().catch(4),
  frameRate: z.literal(16).optional().catch(16),
  duration: numberEnum(wanDuration).optional().catch(5),
  seed: seedSchema,
  resources: z.array(resourceSchema.passthrough()).nullable().default(null),
});

export const wanGenerationConfig = VideoGenerationConfig2({
  label: 'Wan',
  whatIfProps: [
    'process',
    'duration',
    'steps',
    'aspectRatio',
    'cfgScale',
    'draft',
    'resources',
    'sourceImage',
  ],
  metadataDisplayProps: ['process', 'cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
  schema,
  defaultValues: {
    process: 'txt2vid',
    baseModel: 'WanVideo14B_T2V',
    aspectRatio: '1:1',
    duration: 5,
    cfgScale: 4,
    frameRate: 16,
  },
  processes: ['txt2vid', 'img2vid'],
  transformFn: (data) => {
    if (!data.sourceImage) {
      data.process = 'txt2vid';
    }
    if (data.process === 'txt2vid') {
      delete data.sourceImage;
    } else if (data.process === 'img2vid') {
      delete data.aspectRatio;
    }
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
  inputFn: ({ sourceImage, resources, baseModel, ...args }): WanVdeoGenInput => {
    const ar = sourceImage
      ? AspectRatio.fromSize(sourceImage, { multiplier: 16 })
      : wanAspectRatioMap[args.aspectRatio ?? '1:1'];
    const { width, height } = ar.getSize2(480);
    const model = baseModel
      ? wanBaseModelMap[baseModel as keyof typeof wanBaseModelMap].model
      : undefined;
    return {
      ...args,
      width,
      height,
      sourceImage: sourceImage?.url,
      steps: 20,
      loras: resources?.map(({ air, strength }) => ({ air, strength })),
      model,
      // model: !sourceImage ? 'urn:air:wanvideo:checkpoint:civitai:1329096@1707796' : undefined,
    };
  },
});
