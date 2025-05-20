import { MiniMaxVideoGenInput, MiniMaxVideoGenModel } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseVideoGenerationSchema,
  promptSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('minimax').catch('minimax'),
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
    if (!data.sourceImage) {
      data.process = 'txt2vid';
    }
    if (data.process === 'txt2vid') {
      delete data.sourceImage;
    }
    return data;
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
  inputFn: ({ sourceImage, ...args }): MiniMaxVideoGenInput => {
    return {
      ...args,
      sourceImage: sourceImage?.url,
      model: MiniMaxVideoGenModel.HAILOU,
    };
  },
});
