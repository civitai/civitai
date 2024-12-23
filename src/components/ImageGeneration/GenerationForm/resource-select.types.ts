import { ModelSearchIndexSortBy } from '~/components/Search/parsers/model.parser';
import { BaseModel } from '~/server/common/constants';
import { ModelType } from '~/shared/utils/prisma/enums';

export type ResourceSelectOptions = {
  canGenerate?: boolean;
  resources?: { type: string; baseModels?: string[] }[];
  excludeIds?: number[];
};

const selectSources = ['generation', 'training', 'addResource', 'modelVersion'] as const;
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
