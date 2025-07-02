import type { Veo3VideoGenInput } from '@civitai/client';
import * as z from 'zod/v4';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  negativePromptSchema,
  seedSchema,
  promptSchema,
  baseVideoGenerationSchema,
  sourceImageSchema,
  resourceSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const veo3AspectRatios = ['16:9', '1:1', '9:16'] as const;
export const veo3Duration = [8] as const;

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('veo3').catch('veo3'),
  // sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema,
  enablePromptEnhancer: z.boolean().default(false),
  aspectRatio: z.enum(veo3AspectRatios).optional().catch('16:9'),
  duration: numberEnum(veo3Duration).default(8).catch(8),
  generateAudio: z.boolean().optional(),
  seed: seedSchema,
  resources: resourceSchema.array().nullable().default(null),
});

export const veo3ModelVersionId = 1885367;
export const veo3GenerationConfig = VideoGenerationConfig2({
  label: 'Google VEO 3',
  whatIfProps: ['sourceImage', 'duration', 'aspectRatio', 'generateAudio'],
  metadataDisplayProps: ['process', 'aspectRatio', 'duration', 'seed'],
  schema,
  defaultValues: {
    aspectRatio: '16:9',
    generateAudio: false,
    resources: [{ id: 1885367, air: 'urn:air:other:checkpoint:civitai:1665714@1885367' }],
  },
  processes: ['txt2vid'],
  transformFn: (data) => ({ ...data, process: 'txt2vid' }),
  // transformFn: (data) => {
  //   if (!data.sourceImage) {
  //     data.process = 'txt2vid';
  //   }
  //   if (data.process === 'txt2vid') {
  //     delete data.sourceImage;
  //   } else if (data.process === 'img2vid') {
  //     delete data.aspectRatio;
  //   }
  //   return data;
  // },

  // superRefine: (data, ctx) => {
  //   if (!data.sourceImage && !data.prompt?.length) {
  //     ctx.addIssue({
  //       code: z.ZodIssueCode.custom,
  //       message: 'Prompt is required',
  //       path: ['prompt'],
  //     });
  //   }
  // },
  inputFn: ({ ...args }): Veo3VideoGenInput => {
    return {
      ...args,
      // sourceImage: sourceImage?.url,
    };
  },
});
