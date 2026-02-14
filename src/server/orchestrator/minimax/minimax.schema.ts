import type { MiniMaxVideoGenInput } from '@civitai/client';
import { MiniMaxVideoGenModel } from '@civitai/client';
import * as z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseVideoGenerationSchema,
  promptSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('minimax').default('minimax').catch('minimax'),
  sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
});

export const minimaxGenerationConfig = VideoGenerationConfig2({
  label: 'Hailuo by MiniMax',
  whatIfProps: ['process'],
  metadataDisplayProps: ['process'],
  schema,
  processes: ['txt2vid', 'img2vid'],
  transformFn: (data) => {
    delete data.priority;
    if (!data.sourceImage) {
      data.process = 'txt2vid';
    }
    if (data.process === 'txt2vid') {
      delete data.sourceImage;
    }
    return { ...data, baseModel: 'MiniMax' };
  },
  superRefine: (data, ctx) => {
    if (!data.sourceImage && !data.prompt?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Prompt is required',
        path: ['prompt'],
      });
    }
  },
  inputFn: ({ sourceImage, ...args }): MiniMaxVideoGenInput => {
    return {
      ...args,
      sourceImage: sourceImage?.url,
      model: MiniMaxVideoGenModel.HAILOU,
    };
  },
});
