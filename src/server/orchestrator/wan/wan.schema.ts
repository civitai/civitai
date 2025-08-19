// import type { Wan21CivitaiVideoGenInput, Wan21FalVideoGenInput } from '@civitai/client';
import type { CivitaiWanVideoGenInput, FalWanVideoGenInput } from '@civitai/client';
import * as z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  seedSchema,
  promptSchema,
  resourceSchema,
  baseVideoGenerationSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import type { BaseModelGroup } from '~/shared/constants/base-model.constants';
import {
  findClosestAspectRatio,
  getResolutionsFromAspectRatiosMap,
} from '~/utils/aspect-ratio-helpers';
import { numberEnum, zodEnumFromObjKeys } from '~/utils/zod-helpers';

export const wanAspectRatios = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
const wanFalAspectRatios = ['16:9', '1:1', '9:16'] as const;
export const wanDuration = [3, 5] as const;
export const wanResolution = [480, 720] as const;
export const wan22InterpolatorModels = ['film', 'rife'];
export const wanVersions = ['v2.1', 'v2.2', 'v2.2-5B'];

type WanVersion = (typeof wanVersions)[number];
export const wanVersionMap = new Map<WanVersion, BaseModelGroup[]>([
  [
    'v2.1',
    [
      'WanVideo',
      'WanVideo1_3B_T2V',
      'WanVideo14B_T2V',
      'WanVideo14B_I2V_480p',
      'WanVideo14B_I2V_720p',
    ],
  ],
  ['v2.2', ['WanVideo-22-I2V-A14B', 'WanVideo-22-T2V-A14B']],
  ['v2.2-5B', ['WanVideo-22-TI2V-5B']],
]);

export function getWanVersion(baseModel: string) {
  return [...wanVersionMap.entries()].find(([_, baseModels]) =>
    baseModels.includes(baseModel as BaseModelGroup)
  )?.[0];
}

const resolutionMap = getResolutionsFromAspectRatiosMap([...wanResolution], [...wanAspectRatios]);

const wanBaseModels = [
  {
    baseModelGroup: 'WanVideo14B_T2V',
    version: 'v2.1',
    processes: ['txt2vid'],
    resolutions: [480],
  },
];

export const wanBaseModelGroupIdMap: Partial<Record<BaseModelGroup, number>> = {
  WanVideo1_3B_T2V: 1500646,
  WanVideo14B_T2V: 1707796,
  WanVideo14B_I2V_480p: 1501125,
  WanVideo14B_I2V_720p: 1501344,
};

export const wanBaseModelMap = {
  // WanVideo1_3B_T2V: {
  //   process: 'txt2vid',
  //   label: 'Wan Video 1.3B t2v',
  //   model: 'urn:air:wanvideo1_3b_t2v:checkpoint:civitai:1329096@1500646',
  //   default: false,
  //   resolution: 480,
  //   provider: 'civitai',
  //   aspectRatios: wanAspectRatios,
  // },
  WanVideo14B_T2V: {
    process: 'txt2vid',
    label: '480p',
    model: 'urn:air:wanvideo14b_t2v:checkpoint:civitai:1329096@1707796',
    default: true,
    resolution: 480,
    provider: 'civitai',
    aspectRatios: wanAspectRatios,
  },
  // WanVideo14B_T2V: {
  //   process: 'txt2vid',
  //   label: '720p',
  //   model: 'urn:air:wanvideo14b_t2v:checkpoint:civitai:1329096@1707796',
  //   default: true,
  //   resolution: 720,
  //   provider: 'fal',
  //   aspectRatios: wanFalAspectRatios,
  // },
  WanVideo14B_I2V_480p: {
    process: 'img2vid',
    label: '480p',
    model: 'urn:air:wanvideo14b_i2v_480p:checkpoint:civitai:1329096@1501125',
    default: false,
    resolution: 480,
    provider: 'civitai',
    aspectRatios: wanAspectRatios,
  },
  WanVideo14B_I2V_720p: {
    process: 'img2vid',
    label: '720p',
    model: 'urn:air:wanvideo14b_i2v_720p:checkpoint:civitai:1329096@1501344',
    default: true,
    resolution: 720,
    provider: 'fal',
    aspectRatios: wanFalAspectRatios,
  },
};

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('wan').default('wan').catch('wan'),
  baseModel: zodEnumFromObjKeys(wanBaseModelMap),
  prompt: promptSchema,
  aspectRatio: z.enum(wanAspectRatios).optional().catch('1:1'),
  sourceImage: sourceImageSchema.nullish(),
  images: sourceImageSchema.array().nullish(),
  cfgScale: z.number().min(1).max(10).optional().catch(4),
  frameRate: z.literal(16).optional().catch(16),
  duration: numberEnum(wanDuration).optional().catch(5),
  seed: seedSchema,
  resources: z.array(resourceSchema).nullable().default(null),
});

export const wanGenerationConfig = VideoGenerationConfig2({
  label: 'Wan',
  whatIfProps: [
    'process',
    'duration',
    'steps',
    'aspectRatio',
    'cfgScale',
    'draft',
    'resources',
    'baseModel',
    'images',
  ],
  metadataDisplayProps: ['process', 'cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
  schema,
  defaultValues: {
    process: 'txt2vid',
    baseModel: 'WanVideo14B_T2V',
    aspectRatio: '1:1',
    duration: 5,
    cfgScale: 4,
    frameRate: 16,
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
    const config = wanBaseModelMap[data.baseModel!];
    if (!data.process) {
      if (data.baseModel?.includes('i2v')) {
        data.process = 'img2vid';
      } else if (data.baseModel?.includes('t2v')) {
        data.process = 'txt2vid';
      }
    }

    if (data.process === 'txt2vid') {
      delete data.sourceImage;
      delete data.images;
    } else if (data.process === 'img2vid') {
      delete data.aspectRatio;
      delete data.sourceImage;
    }

    if (config.provider === 'fal') {
      const imageOrAspectRatio = data.sourceImage ?? data.aspectRatio;
      const aspectRatio = imageOrAspectRatio
        ? findClosestAspectRatio(imageOrAspectRatio, [...wanFalAspectRatios])
        : undefined;
      data.duration = 5;
      data.aspectRatio = aspectRatio as any;
    }

    return { ...data, steps: 20, version: 'v2.1' };
  },
  superRefine: (data, ctx) => {
    if (data.process === 'img2vid' && !data.images?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Image is required',
        path: ['images'],
      });
    }

    if (!data.images?.length && !data.prompt?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Prompt is required',
        path: ['prompt'],
      });
    }
  },
  inputFn: ({
    sourceImage,
    resources,
    baseModel,
    images,
    ...args
  }): CivitaiWanVideoGenInput | FalWanVideoGenInput => {
    const config = wanBaseModelMap[baseModel!];
    const imageUrls = images?.map((x) => x.url);

    const values = {
      ...args,
      // sourceImage: sourceImage?.url,
      // images: images?.map((x) => x.url),
      loras: resources?.map(({ air, strength }) => ({ air, strength })),
    };

    if (config.provider === 'fal') {
      const imageOrAspectRatio = images?.[0] ?? args.aspectRatio;
      const aspectRatio = imageOrAspectRatio
        ? findClosestAspectRatio(imageOrAspectRatio, [...wanFalAspectRatios])
        : undefined;
      return {
        ...values,
        sourceImage: imageUrls?.[0],
        provider: 'fal',
        aspectRatio,
        enablePromptExpansion: false,
      } as FalWanVideoGenInput;
    } else {
      const aspectRatios = resolutionMap.get(config.resolution)!;
      const aspectRatio = findClosestAspectRatio(images?.[0] ?? args.aspectRatio ?? '1:1', [
        ...wanAspectRatios,
      ]);
      const [width, height] = aspectRatios[aspectRatio];
      const model = config.model;
      return {
        ...values,
        sourceImage: imageUrls?.[0],
        provider: 'civitai',
        width,
        height,
        model,
      } as CivitaiWanVideoGenInput;
    }
  },
});
