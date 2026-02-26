import type { ViduVideoGenInput } from '@civitai/client';
import { ViduVideoGenStyle } from '@civitai/client';
import * as z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseVideoGenerationSchema,
  promptSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';

export const viduDurations = [4, 8] as const;
export const viduAspectRatios = ['16:9', '1:1', '9:16'] as const;
export const viduMovementAmplitudes = ['auto', 'small', 'medium', 'large'] as const;

// const baseSchema = z.object({
//   engine: z.literal('vidu').default('vidu').catch('vidu'),
//   prompt: promptSchema,
//   enablePromptEnhancer: z.boolean().default(true),
//   duration: z.number().optional(),
//   seed: seedSchema,
//   movementAmplitude: z.enum(viduMovementAmplitudes).default('auto').catch('auto'),
//   model: z.literal('q1').default('q1').catch('q1'),
// });

// const schema2 = z.discriminatedUnion('process', [
//   z.object({
//     process: z.literal('txt2img'),
//     aspectRatio: z.enum(viduAspectRatios).optional().catch('1:1'),
//     style: z.enum(ViduVideoGenStyle).optional().catch(ViduVideoGenStyle.GENERAL),
//     ...baseSchema.shape,
//   }),
//   z.object({
//     process: z.literal('img2img'),
//     sourceImage: sourceImageSchema,
//     endSourceImage: sourceImageSchema.nullish(),
//     ...baseSchema.shape,
//   }),
//   z.object({
//     process: z.literal('ref2img'),
//     images: sourceImageSchema.array().min(1).max(7),
//     aspectRatio: z.enum(viduAspectRatios).optional().catch('1:1'),
//     ...baseSchema.shape,
//   }),
// ]);

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('vidu').default('vidu').catch('vidu'),
  process: z.enum(['txt2vid', 'img2vid', 'ref2vid']).default('txt2vid'),
  sourceImage: sourceImageSchema.nullish(),
  images: sourceImageSchema.array().max(7).nullish(),
  endSourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
  style: z.enum(ViduVideoGenStyle).optional().catch(ViduVideoGenStyle.GENERAL),
  duration: z.number().optional(),
  // duration: numberEnum(viduDurations).optional().catch(4),
  seed: seedSchema,
  aspectRatio: z.enum(viduAspectRatios).optional().catch('1:1'),
  movementAmplitude: z.enum(viduMovementAmplitudes).default('auto').catch('auto'),
  model: z.literal('q1').default('q1').catch('q1'),
  // model: z.enum(ViduVideoGenModel).default('q1').catch('q1'),
});

export const viduGenerationConfig = VideoGenerationConfig2({
  label: 'Vidu Q1',
  whatIfProps: ['duration', 'sourceImage', 'endSourceImage', 'model', 'process'],
  metadataDisplayProps: ['process', 'style', 'duration', 'seed'],
  schema,
  processes: ['txt2vid', 'img2vid', 'ref2vid'],
  defaultValues: {
    sourceImage: null,
    endSourceImage: null,
    images: null,
    style: ViduVideoGenStyle.GENERAL,
    duration: 4,
    model: 'q1',
    aspectRatio: '1:1',
  },
  whatIfFn: (data) => {
    if (data.process === 'img2vid' && !data.sourceImage) {
      data.sourceImage = {
        url: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/3fdba611-f34d-4a68-8bf8-3805629652d3/4a0f3c58d8c6a370bc926efe3279cbad.jpeg',
        width: 375,
        height: 442,
      };
    }
    return data;
  },
  transformFn: (data) => {
    delete data.priority;
    if (data.model === 'q1') {
      data.duration = 5;
    }
    if (!data.sourceImage && !data.images?.length) {
      data.process = 'txt2vid';
    }
    if (data.process === 'txt2vid') {
      delete data.sourceImage;
      delete data.endSourceImage;
      delete data.images;
    } else if (data.process === 'img2vid') {
      delete data.style;
      delete data.aspectRatio;
      delete data.images;
    } else if (data.process === 'ref2vid') {
      delete data.sourceImage;
      delete data.endSourceImage;
      delete data.style;
    }

    if (data.endSourceImage && !data.sourceImage) {
      data.sourceImage = data.endSourceImage;
      delete data.endSourceImage;
    }
    // TODO - get Koen to update the api spec so that I don't have to cast the duration type
    return { ...data, duration: data.duration as (typeof viduDurations)[number], baseModel: 'Vidu' };
  },
  superRefine: (data, ctx) => {
    if (data.process === 'img2vid' && !data.sourceImage) {
      ctx.addIssue({
        code: 'custom',
        message: 'Starting image is required',
        path: ['sourceImage'],
      });
    }
    if (data.process === 'ref2vid' && (!data.images || data.images.length < 3)) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least three images are required',
        path: ['images'],
      });
    }
    if (data.process === 'txt2vid' && !data.prompt?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Prompt is required',
        path: ['prompt'],
      });
    }
  },
  inputFn: ({ sourceImage, endSourceImage, images, ...args }): ViduVideoGenInput => {
    const prompt =
      !args.prompt.length && images
        ? images.map((_, index) => `[@image${index + 1}]`).join()
        : args.prompt;
    return {
      ...args,
      prompt,
      images: images?.map((x) => x.url),
      sourceImage: sourceImage?.url,
      endSourceImage: endSourceImage?.url,
    };
  },
});
