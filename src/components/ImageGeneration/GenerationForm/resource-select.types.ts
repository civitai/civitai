import { versionCanGenerate } from '~/shared/generation/coverage-fields';
import * as z from 'zod';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { constants } from '~/server/common/constants';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { MediaType, TrainingStatus } from '~/shared/utils/prisma/enums';
import { baseModels } from '~/shared/constants/basemodel.constants';
import type { ModelPricingFilter } from '~/shared/search/model-pricing-filter';
import { hasPricingFilter } from '~/shared/search/model-pricing-filter';

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
} & ModelPricingFilter;

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

/** The chip asks a generate-price question, which is the wrong one for the other picker sources. */
export const showsPricingFilter = (selectSource: ResourceSelectSource): boolean =>
  selectSource === 'generation';

/**
 * Which version a picker card should open on.
 *
 * Meilisearch flattens `versions[]`, so the version that satisfied the pricing clause need not be the
 * one that satisfied the base-model clause, nor the first. Compatibility outranks price: a free
 * version this ecosystem cannot use is not a resource the viewer can generate with.
 *
 * With no pricing filter this returns 0 — the short-circuit lives HERE rather than at the call site so
 * a test can reach it. Re-selecting on compatibility alone would change which version an untouched
 * picker opens on, which is the one thing this must never do.
 */
export function pickInitialVersionIndex<T>(
  versions: T[],
  {
    filter,
    satisfiesFilter,
    isCompatible,
  }: {
    filter: ModelPricingFilter;
    satisfiesFilter: (version: T) => boolean;
    isCompatible: (version: T) => boolean;
  }
): number {
  if (!hasPricingFilter(filter)) return 0;
  const preferred = versions.findIndex((v) => isCompatible(v) && satisfiesFilter(v));
  if (preferred >= 0) return preferred;
  const compatible = versions.findIndex(isCompatible);
  return compatible >= 0 ? compatible : 0;
}

/**
 * A mounted card outlives a filter change, so a once-seeded `useState` would keep showing the version
 * the viewer just asked to hide. Keyed rather than reset by an effect.
 */
export function resolveSelectedIndex({
  override,
  filterKey,
  versionCount,
  initialIndex,
}: {
  override: { key: string; index: number } | null;
  filterKey: string;
  versionCount: number;
  initialIndex: number;
}): number {
  if (!override || override.key !== filterKey) return initialIndex;
  return override.index < versionCount ? override.index : initialIndex;
}

/**
 * The tRPC input a picker filter maps to. One place, because the wire between the chip and the query
 * is a single optional property — dropping it leaves the chip rendering, the count incrementing, and
 * the filter silently doing nothing, with typecheck green.
 */
export const toResourceSelectFilterInput = (filters: ResourceFilter) => ({
  filterTypes: filters.types,
  filterBaseModels: filters.baseModels,
  hidePaid: filters.hidePaid,
  filterLoaded: filters.loadedOnly,
});

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
