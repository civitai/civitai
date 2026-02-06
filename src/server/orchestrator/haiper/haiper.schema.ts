import { HaiperVideoGenModel } from '@civitai/client';
import {
  baseVideoGenerationSchema,
  negativePromptSchema,
  seedSchema,
  sourceImageSchema,
} from './../infrastructure/base.schema';
import * as z from 'zod';
import { promptSchema } from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';

export const haiperAspectRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'] as const;
export const haiperDuration = [2, 4, 8] as const;
export const haiperResolution = [720, 1080, 2160] as const;

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('haiper').default('haiper').catch('haiper'),
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(haiperAspectRatios).optional().catch('1:1'),
  sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
  duration: numberEnum(haiperDuration).default(4).catch(4),
  seed: seedSchema,
  resolution: numberEnum(haiperResolution).default(720),
});

export const haiperGenerationConfig = VideoGenerationConfig2({
  label: 'Haiper',
  description: `Generate hyper-realistic and stunning videos with Haiper's next-gen 2.0 model!`,
  whatIfProps: ['duration'],
  metadataDisplayProps: ['process', 'aspectRatio', 'duration', 'seed', 'resolution'],
  schema,
  defaultValues: { aspectRatio: '1:1' },
  processes: ['txt2vid', 'img2vid'],
  transformFn: (data) => {
    delete data.priority;
    if (!data.sourceImage) {
      data.process = 'txt2vid';
    }
    if (data.process === 'txt2vid') {
      delete data.sourceImage;
    } else if (data.process === 'img2vid') {
      delete data.aspectRatio;
    }
    return { ...data, baseModel: 'Haiper' };
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
  inputFn: ({ sourceImage, ...args }) => {
    return {
      ...args,
      sourceImage: sourceImage?.url,
      model: HaiperVideoGenModel.V2,
    };
  },
});
