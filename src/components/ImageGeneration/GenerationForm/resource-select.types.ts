import * as z from 'zod';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { constants } from '~/server/common/constants';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { MediaType, TrainingStatus } from '~/shared/utils/prisma/enums';
import { baseModels } from '~/shared/constants/basemodel.constants';

export type ResourceSelectOptions = {
  canGenerate?: boolean;
  resources?: {
    type: string;
    baseModels?: string[];
    partialSupport?: string[];
  }[];
  excludeIds?: number[];
};

const selectSources = ['generation', 'training', 'addResource', 'modelVersion', 'auction'] as const;
export type ResourceSelectSource = (typeof selectSources)[number];

export type ResourceFilter = {
  types: ModelType[];
  baseModels: BaseModel[];
};

export const resourceSelectTabs = [
  'all',
  'featured',
  'recent',
  'liked',
  'official',
  'mine',
] as const;
export type Tabs = (typeof resourceSelectTabs)[number];

// The official/mine tabs let a creator link any of their own / the official
// component models regardless of base-model match (e.g. a VAE shared across SDXL
// variants). Mirrors the same predicate on the server picker service.
export function skipBaseModelForOwnTabs(tab: Tabs | undefined, selectSource?: string): boolean {
  return (tab === 'mine' || tab === 'official') && selectSource === 'modelVersion';
}

export const resourceSort = {
  relevance: 'Relevance',
  popularity: 'Popularity',
  newest: 'Newest',
} as const;
export type ResourceSort = keyof typeof resourceSort;

export type ImageSelectSource = 'generation' | 'training' | 'uploaded';

export const imageSelectTrainingFilterSchema = z.object({
  hasLabels: z.boolean().nullable(),
  labelType: z.enum(constants.autoLabel.labelTypes).nullable(),
  statuses: z.array(z.enum(TrainingStatus)),
  types: z.array(z.enum(constants.trainingModelTypes)),
  mediaTypes: z.array(z.enum(constants.trainingMediaTypes)),
  baseModels: z.array(z.enum(baseModels)),
});
export type ImageSelectTrainingFilter = z.infer<typeof imageSelectTrainingFilterSchema>;

export const imageSelectProfileFilterSchema = z.object({
  mediaTypes: z.array(z.enum(MediaType)),
});
export type ImageSelectProfileFilter = z.infer<typeof imageSelectProfileFilterSchema>;
