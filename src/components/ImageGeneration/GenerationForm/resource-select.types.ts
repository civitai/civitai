import * as z from 'zod/v4';
import { ModelSearchIndexSortBy } from '~/components/Search/parsers/model.parser';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { constants } from '~/server/common/constants';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { MediaType, TrainingStatus } from '~/shared/utils/prisma/enums';
import { baseModels } from '~/shared/constants/base-model.constants';

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

export const resourceSort = {
  [ModelSearchIndexSortBy[0]]: 'Relevance',
  [ModelSearchIndexSortBy[1]]: 'Popularity',
  [ModelSearchIndexSortBy[7]]: 'Newest',
} as const;
export type ResourceSort = keyof typeof resourceSort;

export type ImageSelectSource = 'generation' | 'training' | 'uploaded';

export const imageSelectTrainingFilterSchema = z.object({
  hasLabels: z.boolean().nullable(),
  labelType: z.enum(constants.autoLabel.labelTypes).nullable(),
  statuses: z.array(z.nativeEnum(TrainingStatus)),
  types: z.array(z.enum(constants.trainingModelTypes)),
  mediaTypes: z.array(z.enum(constants.trainingMediaTypes)),
  baseModels: z.array(z.enum(baseModels)),
});
export type ImageSelectTrainingFilter = z.infer<typeof imageSelectTrainingFilterSchema>;

export const imageSelectProfileFilterSchema = z.object({
  mediaTypes: z.array(z.nativeEnum(MediaType)),
});
export type ImageSelectProfileFilter = z.infer<typeof imageSelectProfileFilterSchema>;
