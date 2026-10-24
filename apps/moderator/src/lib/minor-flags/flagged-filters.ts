/** Auto-flagged's sources: what applied the flag. */
export const FLAGGED_SOURCES = ['all', 'hash', 'text-scan'] as const;
export const FLAGGED_FLAGS = ['all', 'minor', 'poi'] as const;
export const FLAGGED_SORTS = ['oldest', 'newest'] as const;

export type FlaggedSourceFilter = (typeof FLAGGED_SOURCES)[number];
export type FlaggedFlag = (typeof FLAGGED_FLAGS)[number];
export type FlaggedSort = (typeof FLAGGED_SORTS)[number];

export type FlaggedFilters = {
  source: FlaggedSourceFilter;
  flag: FlaggedFlag;
  sort: FlaggedSort;
};

export const DEFAULT_FLAGGED_FILTERS: FlaggedFilters = {
  source: 'all',
  flag: 'all',
  sort: 'oldest',
};

export const FLAGGED_SOURCE_LABELS: Record<FlaggedSourceFilter, string> = {
  all: 'All',
  hash: 'Hash',
  'text-scan': 'Text scan',
};

export const FLAGGED_FLAG_LABELS: Record<FlaggedFlag, string> = {
  all: 'All',
  minor: 'Minor',
  poi: 'Real person',
};

export const FLAGGED_SORT_LABELS: Record<FlaggedSort, string> = {
  oldest: 'Oldest first',
  newest: 'Newest first',
};

export const flaggedFilterParams = (filters: FlaggedFilters): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const k of ['source', 'flag', 'sort'] as const)
    if (filters[k] !== DEFAULT_FLAGGED_FILTERS[k]) params[k] = filters[k];
  return params;
};

/** The flag chips: All clears them, and an active chip switches itself off. */
export const FLAG_CHIP_VALUES: readonly FlaggedFlag[] = ['minor', 'poi'];
