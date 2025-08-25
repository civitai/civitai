import type {
  Wan21CivitaiVideoGenInput,
  Wan21FalVideoGenInput,
  Wan225bFalImageToVideoInput,
  Wan225bFalTextToVideoInput,
  Wan22FalImageToVideoInput,
  Wan22FalTextToVideoInput,
} from '@civitai/client';
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

export const wanVersions = ['v2.1', 'v2.2', 'v2.2-5b'] as const;
export const wanDuration = [3, 5] as const;
const wan21CivitaiAspectRatios = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
const wan21FalAspectRatios = ['16:9', '1:1', '9:16'] as const;
const wan21Resolutions = ['480p', '720p'] as const;
export const wan22InterpolatorModels = ['none', 'film', 'rife'] as const;

export const wan22AspectRatios = ['16:9', '1:1', '9:16'] as const;
export const wan22Resolutions = ['480p', '720p'] as const;
export const wan225bAspectRatios = wan21FalAspectRatios;
export const wan225bResolutions = ['480p', '580p', '720p'] as const;

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

export const wan22BaseModelMap = [
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

export function getWan21ResolutionFromBaseModel(baseModel: BaseModelGroup) {
  const match = wan22BaseModelMap.find((x) => x.baseModel === baseModel);
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
const wan21Schema = baseSchema.extend({
  version: z.literal('v2.1'),
  // baseModel: z.enum(baseModelGroups),
  resolution: z.enum(['480p', '720p']).catch('480p'),
  aspectRatio: z.enum(wan21CivitaiAspectRatios).optional().catch('1:1'),
});
type Wan22Schema = z.infer<typeof wan22Schema>;
const wan22Schema = baseSchema.extend({
  version: z.literal('v2.2'),
  negativePrompt: negativePromptSchema,
  resolution: z.enum(wan22Resolutions).catch('480p'),
  shift: z.number().default(8).catch(8),
  interpolatorModel: z.enum(wan22InterpolatorModels).optional(),
  useTurbo: z.boolean().optional(),
  aspectRatio: z.enum(wan22AspectRatios).optional().catch('1:1'),
});
type Wan225bSchema = z.infer<typeof wan225bSchema>;
const wan225bSchema = baseSchema.extend({
  version: z.literal('v2.2-5b'),
  negativePrompt: negativePromptSchema,
  resolution: z.enum(wan225bResolutions).catch('480p'),
  draft: z.boolean().optional(),
  steps: z.number().catch(40),
  aspectRatio: z.enum(wan225bAspectRatios).optional().catch('1:1'),
  shift: z.number().default(8).catch(8),
});

const schema = z.discriminatedUnion('version', [wan21Schema, wan22Schema, wan225bSchema]);

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
      delete data.duration;
      delete data.priority;
    }
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
      case 'v2.2':
        return handleWan22Input(data);
      case 'v2.2-5b':
        return handleWan225bInput(data);
      default:
        return data;
    }
  },
});

type Wan21Transformed = ReturnType<typeof handleTransformWan21Schema>;
function handleTransformWan21Schema(data: Wan21Schema) {
  const processMatches = wan22BaseModelMap.filter((x) => x.process === data.process);
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

type Wan22Transformed = ReturnType<typeof handleTransformWan22Schema>;
function handleTransformWan22Schema(data: Wan22Schema) {
  const baseModel = data.process === 'txt2vid' ? 'WanVideo-22-T2V-A14B' : 'WanVideo-22-I2V-A14B';
  return { ...data, baseModel };
}

type Wan225bTransformed = ReturnType<typeof handleTransformWan225bSchema>;
function handleTransformWan225bSchema(data: Wan225bSchema) {
  const baseModel = 'WanVideo-22-TI2V-5B';
  return { ...data, baseModel };
}

type WithLoras<T extends { resources?: unknown }> = Omit<T, 'resources'> & {
  loras?: { air: string; strength?: number }[];
};

function handleWan21Input(data: WithLoras<Wan21Transformed>) {
  const images = data.images?.map((x) => x.url);
  const sourceImage = images?.[0];
  if (data.provider === 'civitai') {
    const config = wan22BaseModelMap.find((x) => x.baseModel === data.baseModel);
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
