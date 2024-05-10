import { MantineColor } from '@mantine/core';
import { BaseModel, BaseModelSetType, baseModelSets } from '~/server/common/constants';
import { GenerationRequestStatus } from '~/server/common/enums';

export const generationStatusColors: Record<GenerationRequestStatus, MantineColor> = {
  [GenerationRequestStatus.Pending]: 'yellow',
  [GenerationRequestStatus.Cancelled]: 'gray',
  [GenerationRequestStatus.Processing]: 'yellow',
  [GenerationRequestStatus.Succeeded]: 'green',
  [GenerationRequestStatus.Error]: 'red',
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

export const getBaseModelSetKey = (baseModel?: string) => {
  if (!baseModel) return undefined;
  return Object.entries(baseModelSets).find(
    ([key, baseModels]) => key === baseModel || baseModels.includes(baseModel as BaseModel)
  )?.[0] as BaseModelSetType | undefined;
};
