import type { LightricksVideoGenInput } from '@civitai/client';
import * as z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  negativePromptSchema,
  seedSchema,
  promptSchema,
  baseVideoGenerationSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { numberEnum } from '~/utils/zod-helpers';

export const lightricksAspectRatios = ['16:9', '9:16'] as const;
export const lightricksDuration = [5] as const;

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('lightricks').default('lightricks').catch('lightricks'),
  sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(lightricksAspectRatios).optional().catch('16:9'),
  duration: numberEnum(lightricksDuration).default(5).catch(5),
  cfgScale: z.number().min(3).max(3.5).default(3).catch(3),
  steps: z.number().min(20).max(30).default(25).catch(25),
  frameRate: z.number().optional(),
  seed: seedSchema,
});

export const lightricksGenerationConfig = VideoGenerationConfig2({
  label: 'Lightricks',
  whatIfProps: ['duration', 'cfgScale', 'steps', 'process'],
  metadataDisplayProps: ['process', 'cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
  schema,
  defaultValues: { aspectRatio: '16:9' },
  processes: ['txt2vid', 'img2vid'],
  transformFn: (data) => {
    if (data.process === 'txt2vid') {
      delete data.sourceImage;
    }

    if (data.sourceImage) {
      data.aspectRatio = findClosestAspectRatio(data.sourceImage, [...lightricksAspectRatios]);
    }
    return data;
  },
  superRefine: (data, ctx) => {
    if (data.process === 'img2vid' && !data.sourceImage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Image is required',
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
  inputFn: ({ sourceImage, ...args }): LightricksVideoGenInput => {
    return {
      ...args,
      expandPrompt: false,
      sourceImage: sourceImage?.url,
    };
  },
});
