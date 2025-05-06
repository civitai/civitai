import { KlingMode, KlingModel, KlingVideoGenInput } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseGenerationSchema,
  negativePromptSchema,
  promptSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';

export const klingAspectRatios = ['16:9', '1:1', '9:16'] as const;
export const klingDuration = ['5', '10'] as const;

const klingSchema = baseGenerationSchema.extend({
  engine: z.literal('kling').catch('kling'),
  model: z.nativeEnum(KlingModel).default(KlingModel.V1_5).catch(KlingModel.V1_5),
  sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(klingAspectRatios).optional().catch('1:1'),
  enablePromptEnhancer: z.boolean().default(true),
  mode: z.nativeEnum(KlingMode).catch(KlingMode.STANDARD),
  duration: z.enum(klingDuration).default('5').catch('5'),
  cfgScale: z.number().min(0.1).max(1).default(0.5).catch(0.5),
  seed: seedSchema,
});

export const klingGenerationConfig = VideoGenerationConfig2({
  label: 'Kling',
  whatIfProps: ['mode', 'duration'],
  metadataDisplayProps: ['cfgScale', 'mode', 'aspectRatio', 'duration', 'seed'],
  schema: klingSchema,
  defaultValues: { aspectRatio: '1:1' },
  transformFn: (data) => {
    if (data.sourceImage) delete data.aspectRatio;
    return { ...data, subType: data.sourceImage ? 'img2vid' : 'txt2vid' };
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
  inputFn: ({ sourceImage, ...args }): KlingVideoGenInput => {
    return {
      ...args,
      sourceImage: sourceImage?.url,
    };
  },
});
