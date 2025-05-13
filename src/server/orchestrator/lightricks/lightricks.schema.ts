import { LightricksVideoGenInput } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  negativePromptSchema,
  seedSchema,
  promptSchema,
  baseVideoGenerationSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const lightricksAspectRatios = ['16:9', '3:2', '1:1', '2:3'] as const;
export const lightricksDuration = [5, 10] as const;

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('lightricks').catch('lightricks'),
  sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(lightricksAspectRatios).optional().catch('3:2'),
  duration: numberEnum(lightricksDuration).default(5).catch(5),
  cfgScale: z.number().min(3).max(3.5).default(3).catch(3),
  steps: z.number().min(20).max(30).default(25).catch(25),
  frameRate: z.number().optional(),
  seed: seedSchema,
});

export const lightricksGenerationConfig = VideoGenerationConfig2({
  label: 'Lightricks',
  whatIfProps: ['duration', 'cfgScale', 'steps'],
  metadataDisplayProps: ['cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
  schema,
  defaultValues: { aspectRatio: '3:2' },
  processes: ['txt2vid', 'img2vid'],
  transformFn: (data) => {
    if (data.sourceImage) delete data.aspectRatio;
    return { ...data, process: data.sourceImage ? 'img2vid' : 'txt2vid' };
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
  inputFn: ({ sourceImage, ...args }): LightricksVideoGenInput => {
    return {
      ...args,
      sourceImage: sourceImage?.url,
    };
  },
});
