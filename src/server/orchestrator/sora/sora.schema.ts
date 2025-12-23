import type { Sora2ImageToVideoInput, Sora2TextToVideoInput } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseVideoGenerationSchema,
  promptSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const soraAspectRatios = ['16:9', '9:16'] as const;
// export const soraDurations = [4, 8, 12] as const;
export const soraDurations = [4, 8] as const;
export const soraResolutions = ['720p', '1080p'];

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('sora').default('sora').catch('sora'),
  images: sourceImageSchema.array().nullish(),
  prompt: promptSchema,
  aspectRatio: z.enum(soraAspectRatios).optional().catch('9:16'),
  resolution: z.enum(soraResolutions).default('720p').catch('720p'),
  usePro: z.boolean().default(false),
  duration: numberEnum(soraDurations).default(4).catch(4),
  seed: seedSchema,
});

export const soraGenerationConfig = VideoGenerationConfig2({
  label: 'Sora 2',
  whatIfProps: ['process', 'duration', 'resolution', 'aspectRatio', 'usePro'],
  metadataDisplayProps: ['process', 'duration', 'resolution', 'aspectRatio', 'usePro'],
  schema,
  defaultValues: { aspectRatio: '9:16' },
  processes: ['txt2vid', 'img2vid'],
  transformFn: (data) => {
    delete data.priority;
    if (data.process === 'txt2vid') {
      delete data.images;
    } else {
      delete data.aspectRatio;
    }

    return {
      ...data,
      resources: [{ id: 2320065, air: 'urn:air:sora:checkpoint:civitai:2049999@2320065' }],
    };
  },
  superRefine: ({ resources, ...data }, ctx) => {
    if (data.process === 'img2vid' && !data.images?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Image is required',
        path: ['images'],
      });
    }
    if (!data.images?.length && !data.prompt?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Prompt is required',
        path: ['prompt'],
      });
    }
  },
  inputFn: (data) => {
    if (!data.images?.length) {
      return {
        ...data,
        operation: 'text-to-video',
      } as Sora2TextToVideoInput;
    } else {
      return {
        ...data,
        operation: 'image-to-video',
        images: data.images.map((x) => x.url),
      } as Sora2ImageToVideoInput;
    }
  },
});
