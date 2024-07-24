import { WorkflowStatus } from '@civitai/client';
import { MantineColor } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { Sampler, generation, getGenerationConfig } from '~/server/common/constants';
import { BaseModel, BaseModelSetType, baseModelSets } from '~/server/common/constants';
import { ResourceData } from '~/server/redis/caches';
import { GenerationLimits } from '~/server/schema/generation.schema';
import { RecommendedSettingsSchema } from '~/server/schema/model-version.schema';
import { TextToImageParams } from '~/server/schema/orchestrator/textToImage.schema';
import { AirResourceData } from '~/server/services/orchestrator/common';
import { WorkflowDefinition } from '~/server/services/orchestrator/types';
import { findClosest } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';

export const WORKFLOW_TAGS = {
  IMAGE: 'img',
  TEXT_TO_IMAGE: 'txt2img',
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
  const isSdxl = getIsSdxl(baseModelSetType);
  let value = baseModelSetType;
  if (isSdxl) value = 'SDXL';
  return {
    ...baseInjectableResources,
    draft: draftInjectableResources.find((x) => x.baseModelSetType === value),
  };
}
// #endregion

export const whatIfQueryOverrides = {
  prompt: '',
  negativePrompt: undefined,
  seed: undefined,
  // image: undefined,
  nsfw: false,
  cfgScale: generation.defaultValues.cfgScale,
};

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

export const samplersToComfySamplers: Record<
  Sampler,
  { sampler: string; scheduler: 'normal' | 'karras' | 'exponential' }
> = {
  'Euler a': { sampler: 'euler_ancestral', scheduler: 'normal' },
  Euler: { sampler: 'euler', scheduler: 'normal' },
  LMS: { sampler: 'lms', scheduler: 'normal' },
  Heun: { sampler: 'heun', scheduler: 'normal' },
  DPM2: { sampler: 'dpmpp_2', scheduler: 'normal' },
  'DPM2 a': { sampler: 'dpmpp_2_ancestral', scheduler: 'normal' },
  'DPM++ 2S a': { sampler: 'dpmpp_2s_ancestral', scheduler: 'normal' },
  'DPM++ 2M': { sampler: 'dpmpp_2m', scheduler: 'normal' },
  'DPM++ 2M SDE': { sampler: 'dpmpp_2m_sde', scheduler: 'normal' },
  'DPM++ SDE': { sampler: 'dpmpp_sde', scheduler: 'normal' },
  'DPM fast': { sampler: 'dpm_fast', scheduler: 'normal' },
  'DPM adaptive': { sampler: 'dpm_adaptive', scheduler: 'normal' },
  'LMS Karras': { sampler: 'lms', scheduler: 'karras' },
  'DPM2 Karras': { sampler: 'dpm_2', scheduler: 'karras' },
  'DPM2 a Karras': { sampler: 'dpm_2_ancestral', scheduler: 'karras' },
  'DPM++ 2S a Karras': { sampler: 'dpmpp_2s_ancestral', scheduler: 'karras' },
  'DPM++ 2M Karras': { sampler: 'dpmpp_2m', scheduler: 'karras' },
  'DPM++ 2M SDE Karras': { sampler: 'dpmpp_2m_sde', scheduler: 'karras' },
  'DPM++ SDE Karras': { sampler: 'dpmpp_sde', scheduler: 'karras' },
  'DPM++ 3M SDE': { sampler: 'dpmpp_3m_sde', scheduler: 'normal' },
  'DPM++ 3M SDE Karras': { sampler: 'dpmpp_3m_sde', scheduler: 'karras' },
  'DPM++ 3M SDE Exponential': { sampler: 'dpmpp_3m_sde', scheduler: 'exponential' },
  DDIM: { sampler: 'ddim', scheduler: 'normal' },
  PLMS: { sampler: 'plms', scheduler: 'normal' },
  UniPC: { sampler: 'uni_pc', scheduler: 'normal' },
  LCM: { sampler: 'lcm', scheduler: 'normal' },
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
// some base models, such as SD1.5 can work with different base model set types

export function getBaseModelSetType(baseModel?: string, defaultType?: BaseModelSetType) {
  defaultType ??= 'SD1';
  if (!baseModel) return defaultType;
  return (Object.entries(baseModelSets).find(
    ([key, baseModels]) => key === baseModel || (baseModels as string[]).includes(baseModel)
  )?.[0] ?? defaultType) as BaseModelSetType;
}

export function getResourcesBaseModelSetType(resources: GenerationResource[]) {
  const checkpoint = resources.find((x) => x.modelType === 'Checkpoint');
  if (checkpoint) return getBaseModelSetType(checkpoint.baseModel);
}

export function getBaseModelSet(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return baseModelSets[baseModelSetType] ?? [];
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
export function formatGenerationResources(resources: Array<ResourceData>) {
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
      minor: resource.model.minor,
      available: resource.available,
    };
  });
}

export function sanitizeTextToImageParams<T extends Partial<TextToImageParams>>(
  params: T,
  limits?: GenerationLimits
) {
  if (params.sampler) {
    params.sampler = (generation.samplers as string[]).includes(params.sampler)
      ? params.sampler
      : generation.defaultValues.sampler;
  }

  const maxValueKeys = Object.keys(generation.maxValues);
  for (const item of maxValueKeys) {
    const key = item as keyof typeof generation.maxValues;
    if (params[key]) params[key] = Math.min(params[key] ?? 0, generation.maxValues[key]);
  }

  if (!params.aspectRatio)
    params.aspectRatio = getClosestAspectRatio(params.width, params.height, params.baseModel);

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

export function getSizeFromAspectRatio(aspectRatio: number | string, baseModel?: string) {
  const numberAspectRatio = typeof aspectRatio === 'string' ? Number(aspectRatio) : aspectRatio;
  const config = getGenerationConfig(baseModel);
  return config.aspectRatios[numberAspectRatio];
}

export const getClosestAspectRatio = (width?: number, height?: number, baseModel?: string) => {
  width = width ?? (baseModel === 'SDXL' ? 1024 : 512);
  height = height ?? (baseModel === 'SDXL' ? 1024 : 512);
  const aspectRatios = getGenerationConfig(baseModel).aspectRatios;
  const ratios = aspectRatios.map((x) => x.width / x.height);
  const closest = findClosest(ratios, width / height);
  const index = ratios.indexOf(closest);
  return `${index ?? 0}`;
};

export function getWorkflowDefinitionFeatures(workflow?: {
  features?: WorkflowDefinition['features'];
}) {
  return {
    draft: workflow?.features?.includes('draft') ?? false,
    denoise: workflow?.features?.includes('denoise') ?? false,
    upscale: workflow?.features?.includes('upscale') ?? false,
    image: workflow?.features?.includes('image') ?? false,
  };
}

export function sanitizeParamsByWorkflowDefinition(
  params: TextToImageParams,
  workflow?: {
    features?: WorkflowDefinition['features'];
  }
) {
  const features = getWorkflowDefinitionFeatures(workflow);
  for (const key in features) {
    if (!features[key as keyof typeof features]) delete params[key as keyof typeof features];
  }
}

// #endregion

// #region [config]
export type BaseModelResourceTypes = typeof baseModelResourceTypes;
export type SupportedBaseModel = keyof BaseModelResourceTypes;
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
    {
      type: ModelType.VAE,
      baseModels: [...baseModelSets.SDXL],
    },
  ],
};

export function getBaseModelSetTypes({
  modelType,
  baseModel,
  defaultType = 'SD1',
}: {
  modelType: ModelType;
  baseModel?: string;
  defaultType?: SupportedBaseModel;
}) {
  if (!baseModel) return [defaultType];
  return Object.entries(baseModelResourceTypes)
    .filter(([key, config]) => {
      if (key === baseModel) return true;
      const baseModels = (config.find((x) => x.type === modelType)?.baseModels ?? []) as string[];
      return baseModels.includes(baseModel);
    })
    .map(([key]) => key) as SupportedBaseModel[];
}
// #endregion
