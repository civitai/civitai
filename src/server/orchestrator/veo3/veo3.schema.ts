import type { Veo3VideoGenInput } from '@civitai/client';
import { Veo3Version } from '@civitai/client';
import * as z from 'zod';
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
import { lazy } from '~/shared/utils/lazy';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { parseAIR } from '~/utils/string-helpers';
import { numberEnum } from '~/utils/zod-helpers';

export const veo3AspectRatios = ['16:9', '1:1', '9:16'] as const;
export const veo3Durations = [4, 6, 8];
export const veo3Versions = Object.values(Veo3Version);

export const veo3ModelOptions = [
  {
    label: 'Fast Mode',
    process: 'txt2vid',
    mode: 'fast',
    value: 'urn:air:veo3:checkpoint:civitai:1665714@1995399',
  },
  {
    label: 'Standard',
    process: 'txt2vid',
    mode: 'standard',
    value: 'urn:air:veo3:checkpoint:civitai:1665714@1885367',
  },
  {
    label: 'Fast Mode',
    process: 'img2vid',
    mode: 'fast',
    value: 'urn:air:veo3:checkpoint:civitai:1665714@2082027',
  },
  {
    label: 'Standard',
    process: 'img2vid',
    mode: 'standard',
    value: 'urn:air:veo3:checkpoint:civitai:1665714@1996013',
  },
];

export const getVeo3Models = lazy(() =>
  veo3ModelOptions.map(({ value }) => {
    const { version } = parseAIR(value);
    return { id: version, air: value };
  })
);

export function getVeo3Checkpoint(resources: ResourceInput[] | null) {
  const veo3Models = getVeo3Models();
  const model = resources?.find((x) => veo3Models.some((m) => m.id === x.id));
  return model ?? veo3Models[0];
}

export function removeVeo3CheckpointFromResources(resources: ResourceInput[] | null) {
  return resources?.filter((x) => !getVeo3Models().some((m) => m.id === x.id)) ?? [];
}

export function getVeo3ProcessFromAir(air: string) {
  return veo3ModelOptions.find((x) => x.value === air)?.process ?? 'txt2vid';
}

/*
// TODO
- add duration
- add aspectRatios 16:9, 9:16

*/

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('veo3').default('veo3').catch('veo3'),
  // sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema,
  enablePromptEnhancer: z.boolean().default(false),
  aspectRatio: z.enum(veo3AspectRatios).optional().catch('16:9'),
  duration: numberEnum(veo3Durations).default(8).catch(8),
  generateAudio: z.boolean().optional(),
  seed: seedSchema,
  resources: resourceSchema.array().nullable().default(null),
  images: sourceImageSchema.array().nullish(),
  version: z.enum(veo3Versions).default(Veo3Version['3_0']).catch(Veo3Version['3_0']),
});

export const veo3GenerationConfig = VideoGenerationConfig2({
  label: 'Google VEO 3',
  whatIfProps: ['sourceImage', 'duration', 'aspectRatio', 'generateAudio', 'resources'],
  metadataDisplayProps: ['process', 'aspectRatio', 'duration', 'seed'],
  schema,
  defaultValues: {
    version: Veo3Version['3_0'],
    aspectRatio: '16:9',
    generateAudio: false,
    resources: [getVeo3Models()[0]],
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
      data.duration = 8;
      const image = data.images?.[0];
      if (image) {
        data.aspectRatio = findClosestAspectRatio(image, [...veo3AspectRatios]);
      }
    }
    return { ...data, baseModel: 'Veo3' };
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
    const checkpoint = getVeo3Checkpoint(args.resources);
    const mode = veo3ModelOptions.find((x) => x.value === checkpoint.air)?.mode ?? 'fast';
    const fastMode = mode === 'fast';
    return {
      ...args,
      fastMode,
      images: images?.map((x) => x.url),
    };
  },
});
