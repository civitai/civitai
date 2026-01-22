import type {
  Wan21CivitaiVideoGenInput,
  Wan21FalVideoGenInput,
  Wan225bFalImageToVideoInput,
  Wan225bFalTextToVideoInput,
  Wan22FalImageToVideoInput,
  Wan22FalTextToVideoInput,
  Wan25FalImageToVideoInput,
  Wan25FalTextToVideoInput,
} from '@civitai/client';
import { uniqBy } from 'lodash-es';
import * as z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  seedSchema,
  promptSchema,
  resourceSchema,
  baseVideoGenerationSchema,
  sourceImageSchema,
  negativePromptSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { type BaseModelGroup } from '~/shared/constants/base-model.constants';
import {
  findClosestAspectRatio,
  getResolutionsFromAspectRatios,
} from '~/utils/aspect-ratio-helpers';
import { defaultCatch } from '~/utils/zod-helpers';

export const wanVersions = ['v2.1', 'v2.2', 'v2.2-5b', 'v2.5'] as const;
export const wanDuration = [3, 5] as const;
export const wan25Duration = [5, 10] as const;
const wan21CivitaiAspectRatios = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
const wan21FalAspectRatios = ['16:9', '1:1', '9:16'] as const;
const wan21Resolutions = ['480p', '720p'] as const;
export const wan22InterpolatorModels = ['none', 'film', 'rife'] as const;

export const wan22AspectRatios = ['16:9', '1:1', '9:16'] as const;
export const wan22Resolutions = ['480p', '720p'] as const;
export const wan25Resolutions = [...wan22Resolutions, '1080p'] as const;
export const wan225bAspectRatios = wan21FalAspectRatios;
export const wan225bResolutions = ['580p', '720p'] as const;
export const maxFalAdditionalResources = 2;

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
  ['v2.2-5b', ['WanVideo-22-TI2V-5B']],
  ['v2.5', ['WanVideo-25-T2V', 'WanVideo-25-I2V']],
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

export const wan21BaseModelMap = [
  {
    baseModel: 'WanVideo14B_T2V',
    process: 'txt2vid',
    model: 'urn:air:wanvideo14b_t2v:checkpoint:civitai:1329096@1707796',
    default: true,
    resolution: '480p',
    provider: 'civitai',
    aspectRatios: wan21CivitaiAspectRatios,
  },
  {
    baseModel: 'WanVideo14B_I2V_480p',
    process: 'img2vid',
    model: 'urn:air:wanvideo14b_i2v_480p:checkpoint:civitai:1329096@1501125',
    default: false,
    resolution: '480p',
    provider: 'civitai',
    aspectRatios: wan21CivitaiAspectRatios,
  },
  {
    baseModel: 'WanVideo14B_I2V_720p',
    process: 'img2vid',
    model: 'urn:air:wanvideo14b_i2v_720p:checkpoint:civitai:1329096@1501344',
    default: true,
    resolution: '720p',
    provider: 'fal',
    aspectRatios: wan21FalAspectRatios,
  },
] as const;

export const wanGeneralBaseModelMap = [
  ...wan21BaseModelMap.map(({ baseModel, process, resolution }) => ({
    baseModel,
    process,
    resolution,
  })),
  { baseModel: 'WanVideo-22-T2V-A14B', process: 'txt2vid' },
  { baseModel: 'WanVideo-22-I2V-A14B', process: 'img2vid' },
  { baseModel: 'WanVideo-25-T2V', process: 'txt2vid' },
  { baseModel: 'WanVideo-25-I2V', process: 'img2vid' },
];

export function getWan21ResolutionFromBaseModel(baseModel: BaseModelGroup) {
  const match = wan21BaseModelMap.find((x) => x.baseModel === baseModel);
  return match?.resolution;
}

const baseSchema = z.object({
  ...baseVideoGenerationSchema.shape,
  engine: defaultCatch(z.literal('wan'), 'wan'),
  prompt: promptSchema,
  images: sourceImageSchema.array().nullish(),
  cfgScale: z.number().min(1).max(10).optional().catch(4),
  frameRate: z.literal(16).optional().catch(16),
  duration: z.literal(wanDuration).optional().catch(5),
  seed: seedSchema,
  resources: z.array(resourceSchema).nullable().default(null),
  resolution: z.enum(wan21Resolutions).catch('480p'),
  enablePromptExpansion: z.boolean().optional(),
});

type Wan21Schema = z.infer<typeof wan21Schema>;
const wan21Schema = z.object({
  ...baseSchema.shape,
  version: z.literal('v2.1'),
  // baseModel: z.enum(baseModelGroups),
  resolution: z.enum(['480p', '720p']).catch('480p'),
  aspectRatio: z.enum(wan21CivitaiAspectRatios).optional().catch('1:1'),
});
type Wan22Schema = z.infer<typeof wan22Schema>;
const wan22Schema = z.object({
  ...baseSchema.shape,
  version: z.literal('v2.2'),
  negativePrompt: negativePromptSchema,
  resolution: z.enum(wan22Resolutions).catch(wan22Resolutions[0]),
  aspectRatio: z.enum(wan22AspectRatios).optional().catch('1:1'),
  shift: z.number().default(8).catch(8),
  interpolatorModel: z.enum(wan22InterpolatorModels).optional(),
  useTurbo: z.boolean().optional(),
  frameRate: z.literal(24).optional().catch(24),
});
type Wan225bSchema = z.infer<typeof wan225bSchema>;
const wan225bSchema = z.object({
  ...baseSchema.shape,
  version: z.literal('v2.2-5b'),
  negativePrompt: negativePromptSchema,
  resolution: z.enum(wan225bResolutions).catch(wan225bResolutions[0]),
  draft: z.boolean().optional(),
  steps: z.number().catch(40),
  aspectRatio: z.enum(wan225bAspectRatios).optional().catch('1:1'),
  shift: z.number().default(8).catch(8),
  frameRate: z.literal(24).optional().catch(24),
});

type Wan25Schema = z.infer<typeof wan25Schema>;
const wan25Schema = z.object({
  ...baseSchema.shape,
  version: z.literal('v2.5'),
  negativePrompt: negativePromptSchema,
  resolution: z.enum(wan25Resolutions).catch(wan25Resolutions[0]),
  aspectRatio: z.enum(wan22AspectRatios).optional().catch('1:1'),
  frameRate: z.literal(24).optional().catch(24),
  duration: z.literal(wan25Duration).optional().catch(5),
});

const schema = z.discriminatedUnion('version', [
  wan21Schema,
  wan22Schema,
  wan225bSchema,
  wan25Schema,
]);

export const wanGenerationConfig = VideoGenerationConfig2({
  label: 'Wan',
  whatIfProps: [
    'version',
    'process',
    'duration',
    'steps',
    'aspectRatio',
    'cfgScale',
    'draft',
    'resources',
    'resolution',
    'images',
  ],
  metadataDisplayProps: ['process', 'cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
  processes: ['txt2vid', 'img2vid'],
  schema: schema,
  defaultValues: {
    version: 'v2.1',
    process: 'txt2vid',
    aspectRatio: '1:1',
    duration: 5,
    cfgScale: 3.5,
    frameRate: 16,
    resolution: '480p',
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
    else if (data.process === 'img2vid') delete data.aspectRatio;
    if (data.version !== 'v2.1') {
      // delete data.duration;
      delete data.priority;
    }
    switch (data.version) {
      case 'v2.1':
        return handleTransformWan21Schema(data);
      case 'v2.2':
        return handleTransformWan22Schema(data);
      case 'v2.2-5b':
        return handleTransformWan225bSchema(data);
      case 'v2.5':
        return handleTranformWan25Schema(data);
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

    let exceedsMaxResources = false;
    if (
      data.version === 'v2.1' &&
      data.resolution === '720p' &&
      (data.resources ?? []).length > maxFalAdditionalResources
    )
      exceedsMaxResources = true;
    else if (data.version !== 'v2.1' && (data.resources ?? []).length > maxFalAdditionalResources)
      exceedsMaxResources = true;

    if (exceedsMaxResources) {
      ctx.addIssue({
        code: 'custom',
        message: 'Maximum number of resources exceeded',
        path: ['resources'],
      });
    }
  },
  inputFn: ({ resources, ...rest }) => {
    const loras = resources
      ?.filter((x) => !Object.values(baseModelResourceMap).some((y) => x.id === y.id))
      ?.map(({ air, strength }) => ({ air, strength }));
    const data = { ...rest, loras };
    switch (data.version) {
      case 'v2.1':
        return handleWan21Input(data);
      case 'v2.2':
        return handleWan22Input(data);
      case 'v2.2-5b':
        return handleWan225bInput(data);
      case 'v2.5':
        return handleWan25Input(data);
      default:
        return data;
    }
  },
});

type Wan21Transformed = ReturnType<typeof handleTransformWan21Schema>;
function handleTransformWan21Schema(data: Wan21Schema) {
  const processMatches = wan21BaseModelMap.filter((x) => x.process === data.process);
  const match = processMatches.find((x) => x.resolution === data.resolution) ?? processMatches[0];
  const baseModel = match.baseModel;

  if (!data.process) data.process = baseModel.includes('I2V') ? 'img2vid' : 'txt2vid';

  if (match.provider === 'fal') {
    const imageOrAspectRatio = data.images?.[0] ?? data.aspectRatio;
    data.duration = 5;
    data.aspectRatio = imageOrAspectRatio
      ? findClosestAspectRatio(imageOrAspectRatio, [...wan21FalAspectRatios])
      : undefined;
  }

  return {
    ...data,
    baseModel,
    provider: match.provider,
    resolution: match.resolution,
    steps: 20,
  };
}

const baseModelResourceMap = {
  'WanVideo-22-T2V-A14B': {
    id: 2114154,
    air: 'urn:air:wanvideo-22-t2v-a14b:checkpoint:civitai:1817671@2114154',
    strength: 1,
  },
  'WanVideo-22-I2V-A14B': {
    id: 2114157,
    air: 'urn:air:wanvideo-22-i2v-a14b:checkpoint:civitai:1817671@2114157',
    strength: 1,
  },
  'WanVideo-22-TI2V-5B': {
    id: 2114110,
    air: 'urn:air:wanvideo-22-ti2v-5b:checkpoint:civitai:1817671@2114110',
    strength: 1,
  },
  'WanVideo-25-T2V': {
    id: 2254989,
    air: 'urn:air:wanvideo-25-t2v:checkpoint:civitai:1992179@2254989',
    strength: 1,
  },
  'WanVideo-25-I2V': {
    id: 2254963,
    air: 'urn:air:wanvideo-25-i2v:checkpoint:civitai:1992179@2254963',
    strength: 1,
  },
};

type Wan22Transformed = ReturnType<typeof handleTransformWan22Schema>;
function handleTransformWan22Schema(data: Wan22Schema) {
  const baseModel = data.process === 'txt2vid' ? 'WanVideo-22-T2V-A14B' : 'WanVideo-22-I2V-A14B';
  const checkpoint = baseModelResourceMap[baseModel];
  return { ...data, baseModel, resources: uniqBy([checkpoint, ...(data.resources ?? [])], 'id') };
}

type Wan225bTransformed = ReturnType<typeof handleTransformWan225bSchema>;
function handleTransformWan225bSchema(data: Wan225bSchema) {
  const baseModel = 'WanVideo-22-TI2V-5B';
  const checkpoint = baseModelResourceMap[baseModel];
  return { ...data, baseModel, resources: uniqBy([checkpoint, ...(data.resources ?? [])], 'id') };
}

function handleTranformWan25Schema(data: Wan25Schema) {
  const baseModel = data.process === 'txt2vid' ? 'WanVideo-25-T2V' : 'WanVideo-25-I2V';
  const checkpoint = baseModelResourceMap[baseModel];
  return { ...data, baseModel, resources: uniqBy([checkpoint, ...(data.resources ?? [])], 'id') };
}

type WithLoras<T extends { resources?: unknown }> = Omit<T, 'resources'> & {
  loras?: { air: string; strength?: number }[];
};

function handleWan21Input(data: WithLoras<Wan21Transformed>) {
  const images = data.images?.map((x) => x.url);
  const sourceImage = images?.[0];
  if (data.provider === 'civitai') {
    const config = wan21BaseModelMap.find((x) => x.baseModel === data.baseModel);
    const resolution = Number(data.resolution.split('p')[0]);
    const aspectRatios = getResolutionsFromAspectRatios(resolution, [...wan21CivitaiAspectRatios]);
    const aspectRatio = findClosestAspectRatio(data.images?.[0] ?? data.aspectRatio ?? '1:1', [
      ...wan21CivitaiAspectRatios,
    ]);
    const [width, height] = aspectRatios[aspectRatio];
    const model = config?.model;

    return {
      ...data,
      provider: 'civitai',
      width,
      height,
      model,
      sourceImage,
      images,
    } as Wan21CivitaiVideoGenInput;
  } else {
    const aspectRatio = findClosestAspectRatio(data.images?.[0] ?? data.aspectRatio ?? '1:1', [
      ...wan21FalAspectRatios,
    ]);
    return {
      ...data,
      aspectRatio,
      enablePromptExpansion: false,
      sourceImage,
      images,
    } as Wan21FalVideoGenInput;
  }
}

function handleWan22Input(data: WithLoras<Wan22Transformed>) {
  const operation = data.process === 'txt2vid' ? 'text-to-video' : 'image-to-video';
  const aspectRatio = findClosestAspectRatio(data.images?.[0] ?? data.aspectRatio ?? '1:1', [
    ...wan22AspectRatios,
  ]);
  const images = data.images?.map((x) => x.url);
  return { ...data, operation, provider: 'fal', aspectRatio, images } as
    | Wan22FalImageToVideoInput
    | Wan22FalTextToVideoInput;
}

function handleWan225bInput(data: WithLoras<Wan225bTransformed>) {
  const operation = data.process === 'txt2vid' ? 'text-to-video' : 'image-to-video';
  const aspectRatio = findClosestAspectRatio(data.images?.[0] ?? data.aspectRatio ?? '1:1', [
    ...wan225bAspectRatios,
  ]);
  const images = data.images?.map((x) => x.url);
  return {
    ...data,
    operation,
    provider: 'fal',
    aspectRatio,
    images,
    numInferenceSteps: data.steps,
    useDistill: data.draft,
  } as Wan225bFalImageToVideoInput | Wan225bFalTextToVideoInput;
}

function handleWan25Input(data: WithLoras<Wan25Schema>) {
  const operation = data.process === 'txt2vid' ? 'text-to-video' : 'image-to-video';
  const aspectRatio = findClosestAspectRatio(data.images?.[0] ?? data.aspectRatio ?? '1:1', [
    ...wan22AspectRatios,
  ]);
  const images = data.images?.map((x) => x.url);
  return { ...data, operation, provider: 'fal', aspectRatio, images } as
    | Wan25FalTextToVideoInput
    | Wan25FalImageToVideoInput;
}
