import type { Wan21CivitaiVideoGenInput, Wan21FalVideoGenInput } from '@civitai/client';
import * as z from 'zod/v4';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  seedSchema,
  promptSchema,
  resourceSchema,
  baseVideoGenerationSchema,
  sourceImageSchema,
  negativePromptSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { baseModelGroups, type BaseModelGroup } from '~/shared/constants/base-model.constants';
import {
  findClosestAspectRatio,
  getResolutionsFromAspectRatios,
} from '~/utils/aspect-ratio-helpers';
import { defaultCatch } from '~/utils/zod-helpers';

export const wanDuration = [3, 5] as const;
export const wanResolution = [480, 720] as const;
const wanAspectRatios = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
const wanFalAspectRatios = ['16:9', '1:1', '9:16'] as const;
export const wan22InterpolatorModels = ['film', 'rife'] as const;
export const wanVersions = ['v2.1', 'v2.2', 'v2.2-5B'] as const;

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

export const wanBaseModelGroupIdMap: Partial<Record<BaseModelGroup, number>> = {
  WanVideo1_3B_T2V: 1500646,
  WanVideo14B_T2V: 1707796,
  WanVideo14B_I2V_480p: 1501125,
  WanVideo14B_I2V_720p: 1501344,
};

export const wan22BaseModelMap = {
  WanVideo14B_T2V: {
    process: 'txt2vid',
    model: 'urn:air:wanvideo14b_t2v:checkpoint:civitai:1329096@1707796',
    default: true,
    resolution: '480p',
    provider: 'civitai',
    aspectRatios: wanAspectRatios,
  },
  WanVideo14B_I2V_480p: {
    process: 'img2vid',
    model: 'urn:air:wanvideo14b_i2v_480p:checkpoint:civitai:1329096@1501125',
    default: false,
    resolution: '480p',
    provider: 'civitai',
    aspectRatios: wanAspectRatios,
  },
  WanVideo14B_I2V_720p: {
    process: 'img2vid',
    model: 'urn:air:wanvideo14b_i2v_720p:checkpoint:civitai:1329096@1501344',
    default: true,
    resolution: '720p',
    provider: 'fal',
    aspectRatios: wanFalAspectRatios,
  },
};

const baseSchema = z.object({
  ...baseVideoGenerationSchema.shape,
  engine: defaultCatch(z.literal('wan'), 'wan'),
  baseModel: z.enum(baseModelGroups),
  prompt: promptSchema,
  images: sourceImageSchema.array().nullish(),
  cfgScale: z.number().min(1).max(10).optional().catch(4),
  frameRate: z.literal(16).optional().catch(16),
  duration: z.literal(wanDuration).optional().catch(5),
  seed: seedSchema,
  resources: z.array(resourceSchema).nullable().default(null),
  aspectRatio: z.enum(wanAspectRatios).optional().catch('1:1'),
  enablePromptExpansion: z.boolean().optional(),
});

type Wan21Schema = z.infer<typeof wan21Schema>;
const wan21Schema = baseSchema.extend({
  version: z.literal('v2.1'),
  resolution: z.enum(['480p', '720p']).catch('480p'),
});
type Wan22Schema = z.infer<typeof wan22Schema>;
const wan22Schema = baseSchema.extend({
  version: z.literal('v2.2'),
  negativePrompt: negativePromptSchema,
  resolution: z.enum(['480p', '720p']).catch('480p'),
  shift: z.number().optional(),
  interpolatorModel: z.enum(wan22InterpolatorModels).optional(),
  useTurbo: z.boolean().optional(),
});
type Wan225bSchema = z.infer<typeof wan225bSchema>;
const wan225bSchema = baseSchema.extend({
  version: z.literal('v2.2-5b'),
  negativePrompt: negativePromptSchema,
  resolution: z.enum(['480p', '580p', '720p']).catch('480p'),
  useDistill: z.boolean().optional(),
  numInferenceSteps: z.number().optional(),
});

const schema = z.discriminatedUnion('version', [wan21Schema, wan22Schema, wan225bSchema]);

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
    'sourceImage',
    'baseModel',
  ],
  metadataDisplayProps: ['process', 'cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
  processes: ['txt2vid', 'img2vid'],
  schema: schema,
  defaultValues: {
    version: 'v2.1',
    process: 'txt2vid',
    baseModel: 'WanVideo14B_T2V',
    aspectRatio: '1:1',
    duration: 5,
    cfgScale: 4,
    frameRate: 16,
    resolution: wan22BaseModelMap.WanVideo14B_T2V.resolution,
  },
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
    if (data.process === 'txt2vid') delete data.images;
    else delete data.aspectRatio;
    switch (data.version) {
      case 'v2.1':
        return handleTransformWan21Schema(data);
      case 'v2.2':
        return handleTransformWan22Schema(data);
      case 'v2.2-5b':
        return handleTransformWan225bSchema(data);
      default:
        return data;
    }
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
  inputFn: ({ resources, ...rest }) => {
    const loras = resources?.map(({ air, strength }) => ({ air, strength }));
    const data = { ...rest, loras };
    switch (data.version) {
      case 'v2.1':
        return handleWan21Input(data);
    }
    return data;
  },
});

function handleTransformWan21Schema(data: Wan21Schema) {
  const config = wan22BaseModelMap[data.baseModel as keyof typeof wan22BaseModelMap];
  if (!data.process) data.process = data.baseModel?.includes('i2v') ? 'img2vid' : 'txt2vid';
  if (data.process === 'txt2vid') {
    delete data.images;
  } else if (data.process === 'img2vid') {
    delete data.aspectRatio;
  }

  if (config.provider === 'fal') {
    const imageOrAspectRatio = data.images?.[0] ?? data.aspectRatio;
    data.duration = 5;
    data.aspectRatio = imageOrAspectRatio
      ? findClosestAspectRatio(imageOrAspectRatio, [...wanFalAspectRatios])
      : undefined;
  }

  return {
    ...data,
    provider: config.provider,
    resolution: config.resolution,
    steps: 20,
  };
}

function handleTransformWan22Schema(data: Wan22Schema) {
  return { ...data };
}

function handleTransformWan225bSchema(data: Wan225bSchema) {
  return { ...data };
}

function handleWan21Input(data: Omit<ReturnType<typeof handleTransformWan21Schema>, 'resources'>) {
  if (data.provider === 'civitai') {
    const config = wan22BaseModelMap[data.baseModel as keyof typeof wan22BaseModelMap];
    const resolution = Number(data.resolution.split('p')[0]);
    const aspectRatios = getResolutionsFromAspectRatios(resolution, [...wanAspectRatios]);
    const aspectRatio = findClosestAspectRatio(data.images?.[0] ?? data.aspectRatio ?? '1:1', [
      ...wanAspectRatios,
    ]);
    const [width, height] = aspectRatios[aspectRatio];
    const model = config.model;
    return {
      ...data,
      sourceImage: data.images?.[0].url,
      provider: 'civitai',
      width,
      height,
      model,
    } as Wan21CivitaiVideoGenInput;
  } else {
    return {
      ...data,
      sourceImage: data.images?.[0].url,
      enablePromptExpansion: false,
    } as Wan21FalVideoGenInput;
  }
}
