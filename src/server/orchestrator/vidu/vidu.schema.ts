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

const schema = baseGenerationSchema.extend({
  engine: z.literal('vidu').catch('vidu'),
  sourceImage: sourceImageSchema.nullish(),
  endSourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
  style: z.nativeEnum(ViduVideoGenStyle).optional().catch(ViduVideoGenStyle.GENERAL),
  duration: numberEnum(viduDuration).default(4).catch(4),
  seed: seedSchema,
});

export const viduGenerationConfig = VideoGenerationConfig2({
  label: 'Vidu',
  whatIfProps: ['duration', 'sourceImage', 'endSourceImage'],
  metadataDisplayProps: ['style', 'duration', 'seed'],
  schema,
  processes: ['txt2vid', 'img2vid'],
  defaultValues: { sourceImage: null, endSourceImage: null, style: ViduVideoGenStyle.GENERAL },
  transformFn: (data) => {
    let sourceImage = data.sourceImage;
    if (!sourceImage) {
      sourceImage = data.endSourceImage;
      data.endSourceImage = null;
    }
    if (sourceImage) {
      delete data.style;
    }
    const process = sourceImage ? 'img2vid' : 'txt2vid';
    return { ...data, sourceImage, process };
  },
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
      sourceImage: sourceImage?.url,
      endSourceImage: endSourceImage?.url,
    };
  },
});
