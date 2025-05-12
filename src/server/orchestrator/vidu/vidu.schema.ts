import { ViduVideoGenInput, ViduVideoGenModel, ViduVideoGenStyle } from '@civitai/client';
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

const schema = baseGenerationSchema.extend({
  engine: z.literal('vidu').catch('vidu'),
  sourceImage: sourceImageSchema.nullish(),
  endSourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
  style: z.nativeEnum(ViduVideoGenStyle).optional().catch(ViduVideoGenStyle.GENERAL),
  duration: numberEnum(viduDuration).optional().catch(4),
  seed: seedSchema,
  model: z.nativeEnum(ViduVideoGenModel).default('q1').catch('q1'),
});

export const viduGenerationConfig = VideoGenerationConfig2({
  label: 'Vidu',
  whatIfProps: ['duration', 'sourceImage', 'endSourceImage', 'model'],
  metadataDisplayProps: ['style', 'duration', 'seed'],
  schema,
  processes: ['txt2vid', 'img2vid'],
  defaultValues: {
    sourceImage: null,
    endSourceImage: null,
    style: ViduVideoGenStyle.GENERAL,
    duration: 4,
    model: 'q1',
  },
  transformFn: (data) => {
    if (data.sourceImage) {
      delete data.style;
      console.log('delete style');
    }
    if (data.model === 'q1') {
      delete data.duration;
      console.log('delete duration');
    }
    const process = data.sourceImage ? 'img2vid' : 'txt2vid';
    return { ...data, process };
  },
  superRefine: (data, ctx) => {
    if (!data.sourceImage && data.endSourceImage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'First frame is required',
        path: ['sourceImage'],
      });
    }
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
      sourceImage: sourceImage?.url,
      endSourceImage: endSourceImage?.url,
    };
  },
});
