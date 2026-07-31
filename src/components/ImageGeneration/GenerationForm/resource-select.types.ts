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

/**
 * Which of a model's versions the picker will actually offer. A model whose every
 * version is filtered out renders no card at all, so this predicate decides what the
 * user sees — extracted from the component so the server-side payload projection can
 * be tested against the real thing instead of a copy that would silently drift.
 *
 * `canGenerate` is compared by IDENTITY, and the index field is tri-state: absent when
 * a version has no generationCoverage row. So `true === undefined` is false, and
 * dropping or coercing that field strips every version from every model.
 */
export function filterResourceVersions<
  V extends { id: number; baseModel: string; canGenerate?: boolean | null }
>(
  model: { type: string; versions: V[] },
  {
    tab,
    selectSource,
    canGenerate,
    resources,
    excludedIds,
  }: {
    tab?: Tabs;
    selectSource?: string;
    canGenerate?: boolean;
    resources: { type: string; baseModels: string[] }[];
    excludedIds: number[];
  }
): V[] {
  // Mirror the server query's base-model relaxation so we don't strip every
  // version client-side (e.g. linking a Flux VAE into a Boogu checkpoint).
  // The featured tab is a cross-ecosystem podium (the server returns winners
  // from any baseModel), so don't re-apply the ecosystem's base-model filter.
  const skipBaseModel = skipBaseModelForOwnTabs(tab, selectSource) || tab === 'featured';
  const modelBaseModels = resources
    .filter((x) => x.type === model.type)
    .flatMap((x) => x.baseModels);

  return model.versions.filter((version) => {
    return (
      (canGenerate ? canGenerate === version.canGenerate : true) &&
      (skipBaseModel ||
        modelBaseModels.length === 0 ||
        modelBaseModels.includes(version.baseModel)) &&
      !excludedIds.includes(version.id)
    );
  });
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
