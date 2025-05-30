import type { ViduVideoGenInput } from '@civitai/client';
import { ViduVideoGenStyle } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseVideoGenerationSchema,
  promptSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const viduDurations = [4, 8] as const;
export const viduAspectRatios = ['16:9', '1:1', '9:16'] as const;
export const viduMovementAmplitudes = ['auto', 'small', 'medium', 'large'] as const;

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('vidu').catch('vidu'),
  sourceImage: sourceImageSchema.nullish(),
  endSourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
  style: z.nativeEnum(ViduVideoGenStyle).optional().catch(ViduVideoGenStyle.GENERAL),
  duration: z.number().optional(),
  // duration: numberEnum(viduDurations).optional().catch(4),
  seed: seedSchema,
  aspectRatio: z.enum(viduAspectRatios).optional().catch('1:1'),
  movementAmplitude: z.enum(viduMovementAmplitudes).default('auto').catch('auto'),
  model: z.literal('q1').default('q1').catch('q1'),
  // model: z.nativeEnum(ViduVideoGenModel).default('q1').catch('q1'),
});

export const viduGenerationConfig = VideoGenerationConfig2({
  label: 'Vidu Q1',
  whatIfProps: ['duration', 'sourceImage', 'endSourceImage', 'model', 'process'],
  metadataDisplayProps: ['process', 'style', 'duration', 'seed'],
  schema,
  processes: ['txt2vid', 'img2vid'],
  defaultValues: {
    sourceImage: null,
    endSourceImage: null,
    style: ViduVideoGenStyle.GENERAL,
    duration: 4,
    model: 'q1',
    aspectRatio: '1:1',
  },
  whatIfFn: (data) => {
    if (data.process === 'img2vid' && !data.sourceImage) {
      data.sourceImage = {
        url: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/3fdba611-f34d-4a68-8bf8-3805629652d3/original=true,quality=90/4a0f3c58d8c6a370bc926efe3279cbad.jpeg',
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
    if (!data.sourceImage) {
      data.process = 'txt2vid';
    }
    if (data.process === 'txt2vid') {
      delete data.sourceImage;
      delete data.endSourceImage;
    } else {
      delete data.style;
      delete data.aspectRatio;
    }

    if (data.endSourceImage && !data.sourceImage) {
      data.sourceImage = data.endSourceImage;
      delete data.endSourceImage;
    }
    // TODO - get Koen to update the api spec so that I don't have to cast the duration type
    return { ...data, duration: data.duration as (typeof viduDurations)[number] };
  },
  superRefine: (data, ctx) => {
    if (data.process === 'img2vid' && !data.sourceImage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Starting image is required',
        path: ['sourceImage'],
      });
    }
    if (data.process === 'txt2vid' && !data.prompt?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Prompt is required',
        path: ['prompt'],
      });
    }
  },
  inputFn: ({ sourceImage, endSourceImage, ...args }): ViduVideoGenInput => {
    return {
      ...args,
      sourceImage: sourceImage?.url,
      endSourceImage: endSourceImage?.url,
    };
  },
});
