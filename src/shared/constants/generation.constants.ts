import { WorkflowStatus } from '@civitai/client';
import { MantineColor } from '@mantine/core';
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

export const orchestratorPendingStatuses: WorkflowStatus[] = [
  'unassigned',
  'preparing',
  'scheduled',
];

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
    ([key, baseModels]) => key === baseModel || baseModels.includes(baseModel as BaseModel)
  )?.[0] ?? defaultType) as BaseModelSetType;
}

export const getBaseModelSet = (baseModel?: string) => {
  if (!baseModel) return undefined;
  return Object.entries(baseModelSets).find(
    ([key, set]) => key === baseModel || set.includes(baseModel as BaseModel)
  )?.[1];
};

export function getIsSdxl(baseModelSetType?: BaseModelSetType) {
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
