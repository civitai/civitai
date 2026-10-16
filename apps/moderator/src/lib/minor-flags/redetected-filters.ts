export const REDETECTED_FLAGS = ['all', 'minor', 'poi'] as const;
export const REDETECTED_SORTS = ['oldest', 'newest'] as const;

export type RedetectedFlag = (typeof REDETECTED_FLAGS)[number];
export type RedetectedSort = (typeof REDETECTED_SORTS)[number];

export type RedetectedFilters = { flag: RedetectedFlag; sort: RedetectedSort };

export const DEFAULT_REDETECTED_FILTERS: RedetectedFilters = { flag: 'all', sort: 'oldest' };

export const REDETECTED_FLAG_LABELS: Record<RedetectedFlag, string> = {
  all: 'All',
  minor: 'Minor',
  poi: 'Real person',
};

export const REDETECTED_SORT_LABELS: Record<RedetectedSort, string> = {
  oldest: 'Oldest detection',
  newest: 'Newest detection',
};

export const redetectedFilterParams = (filters: RedetectedFilters): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const k of ['flag', 'sort'] as const)
    if (filters[k] !== DEFAULT_REDETECTED_FILTERS[k]) params[k] = filters[k];
  return params;
};
