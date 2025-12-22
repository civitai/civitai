import type { KlingVideoGenInput } from '@civitai/client';
import { KlingMode, KlingModel } from '@civitai/client';
import * as z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseVideoGenerationSchema,
  negativePromptSchema,
  promptSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';

export const klingAspectRatios = ['16:9', '1:1', '9:16'] as const;
export const klingDuration = ['5', '10'] as const;
export const klingModels = [KlingModel.V1_6, KlingModel.V2, KlingModel.V2_5_TURBO] as const;

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('kling').default('kling').catch('kling'),
  model: z.enum(KlingModel).default(KlingModel.V1_6).catch(KlingModel.V1_6),
  sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(klingAspectRatios).optional().catch('1:1'),
  enablePromptEnhancer: z.boolean().default(true),
  mode: z.enum(KlingMode).default(KlingMode.STANDARD).catch(KlingMode.STANDARD),
  duration: z.enum(klingDuration).default('5').catch('5'),
  cfgScale: z.number().min(0.1).max(1).default(0.5).catch(0.5),
  seed: seedSchema,
});

export const klingGenerationConfig = VideoGenerationConfig2({
  label: 'Kling',
  whatIfProps: ['mode', 'duration', 'model'],
  metadataDisplayProps: ['process', 'cfgScale', 'mode', 'aspectRatio', 'duration', 'seed'],
  schema,
  defaultValues: { aspectRatio: '1:1' },
  processes: ['txt2vid', 'img2vid'],
  transformFn: (data) => {
    if (data.model !== KlingModel.V1_6) {
      data.mode = 'professional';
    }
    delete data.priority;
    if (!data.sourceImage) {
      data.process = 'txt2vid';
    }
    if (data.process === 'txt2vid') {
      delete data.sourceImage;
    } else {
      delete data.aspectRatio;
    }
    return data;
  },
  superRefine: (data, ctx) => {
    if (data.process === 'img2vid' && !data.sourceImage) {
      ctx.addIssue({
        code: 'custom',
        message: 'Image is required',
        path: ['sourceImage'],
      });
    }
    if (!data.sourceImage && !data.prompt?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Prompt is required',
        path: ['prompt'],
      });
    }
  },
  inputFn: ({ sourceImage, ...args }): KlingVideoGenInput => {
    return {
      ...args,
      sourceImage: sourceImage?.url,
    };
  },
});
