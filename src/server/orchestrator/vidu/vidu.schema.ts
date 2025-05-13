import { ViduVideoGenInput, ViduVideoGenStyle } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseVideoGenerationSchema,
  promptSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const viduDuration = [4, 8] as const;

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('vidu').catch('vidu'),
  sourceImage: sourceImageSchema.nullish(),
  endSourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
  style: z.nativeEnum(ViduVideoGenStyle).optional().catch(ViduVideoGenStyle.GENERAL),
  duration: numberEnum(viduDuration).optional().catch(4),
  seed: seedSchema,
  model: z.literal('q1').default('q1').catch('q1'),
  // model: z.nativeEnum(ViduVideoGenModel).default('q1').catch('q1'),
});

export const viduGenerationConfig = VideoGenerationConfig2({
  label: 'Vidu Q1',
  whatIfProps: ['duration', 'sourceImage', 'endSourceImage', 'model', 'process'],
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
    if (data.model === 'q1') {
      delete data.duration;
    }
    if (data.process === 'txt2vid') {
      delete data.sourceImage;
      delete data.endSourceImage;
    } else {
      delete data.style;
    }

    if (data.endSourceImage && !data.sourceImage) {
      data.sourceImage = data.endSourceImage;
      delete data.endSourceImage;
    }
    return data;
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
