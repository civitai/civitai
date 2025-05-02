import { ViduVideoGenInput, ViduVideoGenStyle } from '@civitai/client';
import z from 'zod';
import {
  VideoGenerationConfig,
  VideoGenerationConfig2,
} from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  imageEnhancementSchema,
  negativePromptSchema,
  promptSchema,
  seedSchema,
  sourceImageSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const viduDuration = [4, 8] as const;

const baseKlingSchema = z.object({
  engine: z.literal('vidu'),
  workflow: z.string(),
  enablePromptEnhancer: z.boolean().default(true),
  style: z.nativeEnum(ViduVideoGenStyle).catch(ViduVideoGenStyle.GENERAL),
  duration: numberEnum(viduDuration).default(4).catch(4),
  seed: seedSchema,
});

const viduTxt2VidSchema = textEnhancementSchema.merge(baseKlingSchema).extend({
  negativePrompt: negativePromptSchema,
});

const viduImg2VidSchema = imageEnhancementSchema
  .merge(baseKlingSchema)
  .extend({ prompt: promptSchema, endSourceImage: sourceImageSchema.optional() });

const viduTxt2ImgConfig = new VideoGenerationConfig({
  subType: 'txt2vid',
  engine: 'vidu',
  schema: viduTxt2VidSchema,
  metadataDisplayProps: ['style', 'duration', 'seed'],
});

const viduImg2VidConfig = new VideoGenerationConfig({
  subType: 'img2vid',
  engine: 'vidu',
  schema: viduImg2VidSchema,
  metadataDisplayProps: ['style', 'duration', 'seed'],
});

export const viduVideoGenerationConfig = [viduTxt2ImgConfig, viduImg2VidConfig];

export function ViduInput({
  ...args
}: z.infer<(typeof viduVideoGenerationConfig)[number]['schema']>): ViduVideoGenInput {
  const sourceImage = 'sourceImage' in args ? args.sourceImage.url : undefined;
  const endSourceImage = 'endSourceImage' in args ? args.endSourceImage?.url : undefined;
  return { ...args, sourceImage, endSourceImage };
}

const viduSchema = z.object({
  engine: z.literal('vidu').catch('vidu'),
  sourceImage: sourceImageSchema.nullish(),
  endSourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  enablePromptEnhancer: z.boolean().default(true),
  style: z.nativeEnum(ViduVideoGenStyle).catch(ViduVideoGenStyle.GENERAL),
  duration: numberEnum(viduDuration).default(4).catch(4),
  seed: seedSchema,
});
// .superRefine((data, ctx) => {
//   if (!data.sourceImage && !data.endSourceImage && !data.prompt?.length) {
//     ctx.addIssue({
//       code: z.ZodIssueCode.custom,
//       message: 'Prompt is required',
//       path: ['prompt'],
//     });
//   }
// });

export const viduGenerationConfig = VideoGenerationConfig2({
  label: 'Vidu',
  whatIfProps: ['duration'],
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
  defaultValues: {},
  inputFn: ({ sourceImage, endSourceImage, ...args }): ViduVideoGenInput => {
    return {
      ...args,
      sourceImage: sourceImage?.url ?? endSourceImage?.url,
      endSourceImage: endSourceImage?.url,
    };
  },
});
