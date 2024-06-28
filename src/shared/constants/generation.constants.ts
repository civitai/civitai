import { WorkflowStatus } from '@civitai/client';
import { MantineColor } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { Sampler, generation } from '~/server/common/constants';
import { BaseModel, BaseModelSetType, baseModelSets } from '~/server/common/constants';
import { ResourceData } from '~/server/redis/caches';
import { GenerationLimits } from '~/server/schema/generation.schema';
import { RecommendedSettingsSchema } from '~/server/schema/model-version.schema';
import { TextToImageParams } from '~/server/schema/orchestrator/textToImage.schema';

export const WORKFLOW_TAGS = {
  TEXT_TO_IMAGE: 'textToImage',
};

export const generationServiceCookie = {
  name: 'generation-service',
  maxAge: 3600,
};

// #region [statuses]
export const generationStatusColors: Record<WorkflowStatus, MantineColor> = {
  unassigned: 'yellow',
  preparing: 'yellow',
  scheduled: 'yellow',
  processing: 'yellow',
  succeeded: 'green',
  failed: 'red',
  expired: 'gray',
  canceled: 'gray',
};

export const orchestratorRefundableStatuses: WorkflowStatus[] = ['failed', 'expired', 'canceled'];
export const orchestratorCompletedStatuses: WorkflowStatus[] = [
  ...orchestratorRefundableStatuses,
  'succeeded',
];
export const orchestratorPendingStatuses: WorkflowStatus[] = [
  'unassigned',
  'preparing',
  'scheduled',
];
// #endregion

// #region [injectable resources]
export type InjectableResource = {
  id: number;
  triggerWord?: string;
  triggerType?: 'negative' | 'positive';
  baseModelSetType?: BaseModelSetType;
  sanitize?: (params: TextToImageParams) => Partial<TextToImageParams>;
};

export const draftInjectableResources = [
  {
    id: 391999,
    baseModelSetType: 'SDXL',
    sanitize: () => ({
      steps: 8,
      cfgScale: 1,
      sampler: 'Euler',
    }),
  } as InjectableResource,
  {
    id: 424706,
    baseModelSetType: 'SD1',
    sanitize: () => ({
      steps: 6,
      cfgScale: 1,
      sampler: 'LCM',
    }),
  } as InjectableResource,
];
const baseInjectableResources = {
  civit_nsfw: {
    id: 106916,
    triggerWord: 'civit_nsfw',
    triggerType: 'negative',
  } as InjectableResource,
  safe_neg: { id: 250712, triggerWord: 'safe_neg', triggerType: 'negative' } as InjectableResource,
  safe_pos: { id: 250708, triggerWord: 'safe_pos', triggerType: 'positive' } as InjectableResource,
};
export const allInjectableResourceIds = [
  ...Object.values(baseInjectableResources),
  ...draftInjectableResources,
].map((x) => x.id);

export function getInjectablResources(baseModelSetType: BaseModelSetType) {
  return {
    ...baseInjectableResources,
    draft: draftInjectableResources.find((x) => x.baseModelSetType === baseModelSetType),
  };
}
// #endregion

export const samplersToSchedulers: Record<Sampler, string> = {
  'Euler a': 'EulerA',
  Euler: 'Euler',
  LMS: 'LMS',
  Heun: 'Heun',
  DPM2: 'DPM2',
  'DPM2 a': 'DPM2A',
  'DPM++ 2S a': 'DPM2SA',
  'DPM++ 2M': 'DPM2M',
  'DPM++ 2M SDE': 'DPM2MSDE',
  'DPM++ SDE': 'DPMSDE',
  'DPM fast': 'DPMFast',
  'DPM adaptive': 'DPMAdaptive',
  'LMS Karras': 'LMSKarras',
  'DPM2 Karras': 'DPM2Karras',
  'DPM2 a Karras': 'DPM2AKarras',
  'DPM++ 2S a Karras': 'DPM2SAKarras',
  'DPM++ 2M Karras': 'DPM2MKarras',
  'DPM++ 2M SDE Karras': 'DPM2MSDEKarras',
  'DPM++ SDE Karras': 'DPMSDEKarras',
  'DPM++ 3M SDE': 'DPM3MSDE',
  'DPM++ 3M SDE Karras': 'DPM3MSDEKarras',
  'DPM++ 3M SDE Exponential': 'DPM3MSDEExponential',
  DDIM: 'DDIM',
  PLMS: 'PLMS',
  UniPC: 'UniPC',
  LCM: 'LCM',
};

// TODO - improve this
export const defaultCheckpoints: Record<
  string,
  {
    ecosystem: string;
    type: string;
    source: string;
    model: number;
    version: number;
  }
> = {
  SD1: {
    ecosystem: 'sd1',
    type: 'model',
    source: 'civitai',
    model: 4384,
    version: 128713,
  },
  SDXL: {
    ecosystem: 'sdxl',
    type: 'model',
    source: 'civitai',
    model: 101055,
    version: 128078,
  },
  Pony: {
    ecosystem: 'sdxl',
    type: 'model',
    source: 'civitai',
    model: 257749,
    version: 290640,
  },
};

// #region [utils]
export function getBaseModelSetType(baseModel?: string, defaultType?: BaseModelSetType) {
  defaultType ??= 'SD1';
  if (!baseModel) return defaultType;
  return (Object.entries(baseModelSets).find(
    ([key, baseModels]) => key === baseModel || (baseModels as string[]).includes(baseModel)
  )?.[0] ?? defaultType) as BaseModelSetType;
}

export function getIsSdxl(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return (
    baseModelSetType === 'SDXL' ||
    baseModelSetType === 'Pony' ||
    baseModelSetType === 'SDXLDistilled'
  );
}

export type GenerationResource = MakeUndefinedOptional<
  ReturnType<typeof formatGenerationResources>[number]
>;
export function formatGenerationResources(resources: ResourceData[]) {
  return resources.map((resource) => {
    const settings = resource.settings as RecommendedSettingsSchema;
    return {
      id: resource.id,
      name: resource.name,
      trainedWords: resource.trainedWords,
      modelId: resource.model.id,
      modelName: resource.model.name,
      modelType: resource.model.type,
      baseModel: resource.baseModel,
      strength: settings?.strength ?? 1,
      minStrength: settings?.minStrength ?? -1,
      maxStrength: settings?.maxStrength ?? 2,
      covered: resource.covered,
    };
  });
}

export function sanitizeTextToImageParams<T extends Partial<TextToImageParams>>(
  params: T,
  limits?: GenerationLimits
) {
  if (params.sampler) {
    params.sampler = generation.samplers.includes(params.sampler as any)
      ? params.sampler
      : generation.defaultValues.sampler;
  }

  const maxValueKeys = Object.keys(generation.maxValues);
  for (const item of maxValueKeys) {
    const key = item as keyof typeof generation.maxValues;
    if (params[key]) params[key] = Math.min(params[key] ?? 0, generation.maxValues[key]);
  }

  // handle SDXL ClipSkip
  // I was made aware that SDXL only works with clipSkip 2
  // if that's not the case anymore, we can rollback to just setting
  // this for Pony resources -Manuel
  const isSDXL = getIsSdxl(params.baseModel);
  if (isSDXL) params.clipSkip = 2;

  if (limits) {
    if (params.steps) params.steps = Math.min(params.steps, limits.steps);
    if (params.quantity) params.quantity = Math.min(params.quantity, limits.quantity);
  }
  return params;
}
// #endregion

// #region [comfy]
export const hiresWorkflow = {
  '3': {
    inputs: {
      seed: 89848141647836,
      steps: 12,
      cfg: 8,
      sampler_name: 'dpmpp_sde',
      scheduler: 'normal',
      denoise: 1,
      model: ['16', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
    class_type: 'KSampler',
    _meta: {
      title: 'KSampler',
    },
  },
  '5': {
    inputs: {
      width: 768,
      height: 768,
      batch_size: 1,
    },
    class_type: 'EmptyLatentImage',
    _meta: {
      title: 'Empty Latent Image',
    },
  },
  '6': {
    inputs: {
      text: 'masterpiece HDR victorian portrait painting of woman, blonde hair, mountain nature, blue sky\n',
      clip: ['16', 1],
    },
    class_type: 'CLIPTextEncode',
    _meta: {
      title: 'CLIP Text Encode (Prompt)',
    },
  },
  '7': {
    inputs: {
      text: 'bad hands, text, watermark\n',
      clip: ['16', 1],
    },
    class_type: 'CLIPTextEncode',
    _meta: {
      title: 'CLIP Text Encode (Prompt)',
    },
  },
  '8': {
    inputs: {
      samples: ['3', 0],
      vae: ['16', 2],
    },
    class_type: 'VAEDecode',
    _meta: {
      title: 'VAE Decode',
    },
  },
  '9': {
    inputs: {
      filename_prefix: 'ComfyUI',
      images: ['8', 0],
    },
    class_type: 'SaveImage',
    _meta: {
      title: 'Save Image',
    },
  },
  '10': {
    inputs: {
      upscale_method: 'nearest-exact',
      width: 1152,
      height: 1152,
      crop: 'disabled',
      samples: ['3', 0],
    },
    class_type: 'LatentUpscale',
    _meta: {
      title: 'Upscale Latent',
    },
  },
  '11': {
    inputs: {
      seed: 469771404043268,
      steps: 14,
      cfg: 8,
      sampler_name: 'dpmpp_2m',
      scheduler: 'simple',
      denoise: 0.5,
      model: ['16', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['10', 0],
    },
    class_type: 'KSampler',
    _meta: {
      title: 'KSampler',
    },
  },
  '12': {
    inputs: {
      filename_prefix: 'ComfyUI',
      images: ['13', 0],
    },
    class_type: 'SaveImage',
    _meta: {
      title: 'Save Image',
    },
  },
  '13': {
    inputs: {
      samples: ['11', 0],
      vae: ['16', 2],
    },
    class_type: 'VAEDecode',
    _meta: {
      title: 'VAE Decode',
    },
  },
  '16': {
    inputs: {
      ckpt_name: 'v2-1_768-ema-pruned.ckpt',
    },
    class_type: 'CheckpointLoaderSimple',
    _meta: {
      title: 'Load Checkpoint',
    },
  },
};
// #endregion

// #region [config]

// pixel upscaler vs latent upscaler
// pixel upscalers trained on a style
// latent upscalers trained on a base model type

export type SupportedBaseModel = 'SD1' | 'SDXL' | 'Pony';
export type BaseModelResourceTypes = typeof baseModelResourceTypes;
export const baseModelResourceTypes = {
  SD1: [
    { type: ModelType.Checkpoint, baseModels: [...baseModelSets.SD1] },
    { type: ModelType.TextualInversion, baseModels: [...baseModelSets.SD1] },
    { type: ModelType.LORA, baseModels: [...baseModelSets.SD1] },
    { type: ModelType.DoRA, baseModels: [...baseModelSets.SD1] },
    { type: ModelType.LoCon, baseModels: [...baseModelSets.SD1] },
    { type: ModelType.VAE, baseModels: [...baseModelSets.SD1] },
    { type: ModelType.Upscaler, baseModels: [...baseModelSets.SD1] },
  ],
  SDXL: [
    { type: ModelType.Checkpoint, baseModels: [...baseModelSets.SDXL] },
    { type: ModelType.TextualInversion, baseModels: [...baseModelSets.SDXL, 'SD 1.5'] },
    { type: ModelType.LORA, baseModels: [...baseModelSets.SDXL] },
    { type: ModelType.DoRA, baseModels: [...baseModelSets.SDXL] },
    { type: ModelType.LoCon, baseModels: [...baseModelSets.SDXL] },
    { type: ModelType.VAE, baseModels: [...baseModelSets.SDXL] },
    { type: ModelType.Upscaler, baseModels: [...baseModelSets.SDXL] },
  ],
  Pony: [
    { type: ModelType.Checkpoint, baseModels: [...baseModelSets.Pony] },
    { type: ModelType.TextualInversion, baseModels: ['SD 1.5'] },
    {
      type: ModelType.LORA,
      baseModels: [...baseModelSets.Pony, 'SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM'],
    },
    {
      type: ModelType.DoRA,
      baseModels: [...baseModelSets.Pony, 'SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM'],
    },
    {
      type: ModelType.LoCon,
      baseModels: [...baseModelSets.Pony, 'SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM'],
    },
  ],
};

/*
<ResourcePicker>{({segments}) => {
  const [segment1, segment2, segment3] = segments;

  each segment has controls, changing any value updates the resource picker `resources` value

  return <></>
}}</ResourcePicker>

*/

// #endregion
