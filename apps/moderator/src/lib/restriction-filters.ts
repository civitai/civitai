import { defaultSortFor, type SortOrder } from './restriction-types';

export const RESTRICTION_STATUSES = ['Pending', 'Upheld', 'Overturned', 'any'] as const;
export const ORIGIN_FILTERS = ['remix', 'typed', 'unchanged-remix'] as const;
export const RESTRICTION_ORIGINS = ['all', ...ORIGIN_FILTERS] as const;

export type RestrictionStatusFilter = (typeof RESTRICTION_STATUSES)[number];
export type OriginFilter = (typeof ORIGIN_FILTERS)[number];
export type RestrictionOriginFilter = (typeof RESTRICTION_ORIGINS)[number];

export type RestrictionFilters = {
  status: RestrictionStatusFilter;
  origin: RestrictionOriginFilter;
  sort: SortOrder;
};

export const DEFAULT_RESTRICTION_FILTERS: RestrictionFilters = {
  status: 'Pending',
  origin: 'all',
  sort: 'oldest',
};

export const RESTRICTION_STATUS_LABELS: Record<RestrictionStatusFilter, string> = {
  Pending: 'Pending',
  Upheld: 'Upheld',
  Overturned: 'Overturned',
  any: 'Any',
};

export const RESTRICTION_ORIGIN_LABELS: Record<RestrictionOriginFilter, string> = {
  all: 'All',
  remix: 'Has a remix',
  typed: 'Typed',
  'unchanged-remix': 'Unchanged remix',
};

/** The sort follows the status unless the URL names one. */
export const resolveRestrictionFilters = (
  parsed: Partial<RestrictionFilters>
): RestrictionFilters => {
  const status = parsed.status ?? DEFAULT_RESTRICTION_FILTERS.status;
  return {
    status,
    origin: parsed.origin ?? DEFAULT_RESTRICTION_FILTERS.origin,
    sort: parsed.sort ?? defaultSortFor(status === 'any' ? undefined : status),
  };
};

/** The params an action href carries: only what differs from the default for that status. */
export const restrictionFilterParams = (filters: RestrictionFilters): Record<string, string> => {
  const params: Record<string, string> = {};
  if (filters.status !== DEFAULT_RESTRICTION_FILTERS.status) params.status = filters.status;
  if (filters.origin !== DEFAULT_RESTRICTION_FILTERS.origin) params.origin = filters.origin;
  if (filters.sort !== resolveRestrictionFilters({ status: filters.status }).sort)
    params.sort = filters.sort;
  return params;
};
