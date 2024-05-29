import { WorkflowStatus } from '@civitai/client';
import { MantineColor } from '@mantine/core';
import { Sampler, draftMode } from '~/server/common/constants';
import { BaseModel, BaseModelSetType, baseModelSets } from '~/server/common/constants';
import { ResourceData } from '~/server/redis/caches';
import { RecommendedSettingsSchema } from '~/server/schema/model-version.schema';

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

export const workflowPendingStatuses: WorkflowStatus[] = ['unassigned', 'preparing', 'scheduled'];

export const safeNegatives = [{ id: 106916, triggerWord: 'civit_nsfw' }];
export const minorNegatives = [{ id: 250712, triggerWord: 'safe_neg' }];
export const minorPositives = [{ id: 250708, triggerWord: 'safe_pos' }];
export const allInjectedNegatives = [...safeNegatives, ...minorNegatives];
export const allInjectedPositives = [...minorPositives];
export const allInjectedIds = [...allInjectedNegatives, ...allInjectedPositives].map((x) => x.id);

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

export function getIsSdxl(baseModelSetType: BaseModelSetType) {
  return (
    baseModelSetType === 'SDXL' ||
    baseModelSetType === 'Pony' ||
    baseModelSetType === 'SDXLDistilled'
  );
}
export function getDraftModeSettings(baseModelSetType: BaseModelSetType) {
  const isSDXL = getIsSdxl(baseModelSetType);
  return draftMode[isSDXL ? 'sdxl' : 'sd1'];
}

export type GenerationResource = ReturnType<typeof formatGenerationResources>[number];
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
// #endregion
