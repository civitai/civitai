import { versionCanGenerate } from '~/shared/generation/coverage-fields';
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
  loadedOnly: boolean;
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

/** The fields the picker filters a hit's versions on. */
export type SelectableVersion = {
  id: number;
  baseModel: string;
  canGenerate?: boolean;
  canGenerateNext?: boolean;
  generatorLoaded?: boolean;
};

/**
 * The versions of one hit a user may pick, re-checked client-side: the index filters MODELS, and
 * Meilisearch matching a nested array only proves some version qualified — so a card could otherwise
 * land on one that does not.
 */
export function selectableVersions<V extends SelectableVersion>(
  versions: V[],
  {
    canGenerate,
    coverageNext,
    loadedOnly,
    skipBaseModel,
    modelBaseModels,
    excludedIds,
  }: {
    canGenerate?: boolean;
    /** Which indexed coverage field the server gated this page on. */
    coverageNext?: boolean;
    loadedOnly?: boolean;
    skipBaseModel: boolean;
    modelBaseModels: string[];
    excludedIds: number[];
  }
) {
  return versions.filter(
    (version) =>
      (canGenerate ? canGenerate === versionCanGenerate(version, coverageNext) : true) &&
      (!loadedOnly || !!version.generatorLoaded) &&
      (skipBaseModel ||
        modelBaseModels.length === 0 ||
        modelBaseModels.includes(version.baseModel)) &&
      !excludedIds.includes(version.id)
  );
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
