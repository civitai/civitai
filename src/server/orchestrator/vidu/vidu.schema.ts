import { ViduVideoGenInput, ViduVideoGenStyle } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseGenerationSchema,
  promptSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const viduDuration = [4, 8] as const;

const viduSchema = baseGenerationSchema.extend({
  engine: z.literal('vidu').catch('vidu'),
  sourceImage: sourceImageSchema.nullish(),
  endSourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
  style: z.nativeEnum(ViduVideoGenStyle).catch(ViduVideoGenStyle.GENERAL),
  duration: numberEnum(viduDuration).default(4).catch(4),
  seed: seedSchema,
});

export const viduGenerationConfig = VideoGenerationConfig2({
  label: 'Vidu',
  whatIfProps: ['duration', 'sourceImage', 'endSourceImage'],
  metadataDisplayProps: ['style', 'duration', 'seed'],
  schema: viduSchema,
  superRefine: (data, ctx) => {
    if (!data.sourceImage && !data.endSourceImage && !data.prompt?.length) {
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
      sourceImage: sourceImage?.url ?? endSourceImage?.url,
      endSourceImage: endSourceImage?.url,
    };
  },
});
