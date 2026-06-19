import * as z from 'zod';
import { ModelSearchIndexSortBy } from '~/components/Search/parsers/model.parser';
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
  /**
   * Force the Meili visibility filter to PUBLIC resources only, dropping the
   * `OR user.id = <me>` clause that normally lets a signed-in user see their
   * OWN private models. Used by the App Blocks PAGE resource picker
   * (`OPEN_RESOURCE_PICKER`): an untrusted iframe drives the host's native
   * modal, so a viewer's private library must never be enumerable through it.
   * Defaults to `false` (the in-app generator keeps its own-private visibility).
   */
  publicOnly?: boolean;
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
