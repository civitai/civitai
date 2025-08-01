import type { Veo3VideoGenInput } from '@civitai/client';
import * as z from 'zod/v4';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import type { ResourceInput } from '~/server/orchestrator/infrastructure/base.schema';
import {
  negativePromptSchema,
  seedSchema,
  promptSchema,
  baseVideoGenerationSchema,
  sourceImageSchema,
  resourceSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { numberEnum } from '~/utils/zod-helpers';

export const veo3AspectRatios = ['16:9', '1:1', '9:16'] as const;
export const veo3Duration = [8] as const;
// export const veo3ModelOptions: { label: string; value: ResourceInput }[] = [
//   {
//     label: 'Fast Mode',
//     value: { id: 1885367, air: 'urn:air:other:checkpoint:civitai:1665714@1995399' },
//   },
//   {
//     label: 'Standard',
//     value: { id: 1885367, air: 'urn:air:other:checkpoint:civitai:1665714@1885367' },
//   },
// ];

export const veo3ModelOptions = [
  {
    label: 'Fast Mode',
    value: '1995399',
  },
  {
    label: 'Standard',
    value: '1885367',
  },
];

export const veo3FastModeId = 1995399;
export const veo3StandardId = 1885367;

export const veo3Models = [
  { id: veo3FastModeId, air: 'urn:air:other:checkpoint:civitai:1665714@1995399' },
  { id: veo3StandardId, air: 'urn:air:other:checkpoint:civitai:1665714@1885367' },
];

export function getVeo3Checkpoint(resources: ResourceInput[] | null) {
  const model = resources?.find((x) => veo3Models.some((m) => m.id === x.id));
  return model ?? veo3Models[0];
}

export function getVeo3IsFastMode(modelVersionId?: number) {
  return modelVersionId === veo3Models[0].id;
}

export function removeVeo3CheckpointFromResources(resources: ResourceInput[] | null) {
  return resources?.filter((x) => !veo3Models.some((m) => m.id === x.id)) ?? [];
}

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('veo3').default('veo3').catch('veo3'),
  // sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema,
  enablePromptEnhancer: z.boolean().default(false),
  aspectRatio: z.enum(veo3AspectRatios).optional().catch('16:9'),
  duration: numberEnum(veo3Duration).default(8).catch(8),
  generateAudio: z.boolean().optional(),
  seed: seedSchema,
  resources: resourceSchema.array().nullable().default(null),
  images: sourceImageSchema.array().nullish(),
});

export const veo3ModelVersionId = 1885367;
export const veo3GenerationConfig = VideoGenerationConfig2({
  label: 'Google VEO 3',
  whatIfProps: ['sourceImage', 'duration', 'aspectRatio', 'generateAudio', 'resources'],
  metadataDisplayProps: ['process', 'aspectRatio', 'duration', 'seed'],
  schema,
  defaultValues: {
    aspectRatio: '16:9',
    generateAudio: false,
    resources: [veo3Models[0]],
    images: null,
  },
  processes: ['txt2vid', 'img2vid'],
  whatIfFn: (data) => {
    if (data.process === 'img2vid' && !data.images?.length) {
      data.images = [
        {
          url: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/3fdba611-f34d-4a68-8bf8-3805629652d3/4a0f3c58d8c6a370bc926efe3279cbad.jpeg',
          width: 375,
          height: 442,
        },
      ];
    }
    return data;
  },
  transformFn: (data) => {
    if (data.process === 'txt2vid') {
      delete data.images;
    } else if (data.process === 'img2vid') {
      const image = data.images?.[0];
      if (image) {
        data.aspectRatio = findClosestAspectRatio(image, [...veo3AspectRatios]);
      }
    }
    return data;
  },
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

  superRefine: (data, ctx) => {
    if (data.process === 'img2vid' && !data.images?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Image is required',
        path: ['images'],
      });
    }

    if (!data.prompt.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Prompt is required',
        path: ['prompt'],
      });
    }
  },
  inputFn: ({ images, ...args }): Veo3VideoGenInput => {
    const fastMode = !!args.resources?.find((x) => x.id === veo3Models[0].id);
    return {
      ...args,
      fastMode,
      images: images?.map((x) => x.url),
    };
  },
});
