export const CSAM_HOLD_STATUSES = [
  'pending',
  'lead-review',
  'removed',
  'report-not-filed',
  'dismissed',
  'all',
] as const;
export const CSAM_HOLD_SORTS = ['oldest', 'newest'] as const;

export type CsamHoldStatusFilter = (typeof CSAM_HOLD_STATUSES)[number];
export type CsamHoldSort = (typeof CSAM_HOLD_SORTS)[number];

export type CsamHoldFilters = { status: CsamHoldStatusFilter; sort: CsamHoldSort };

export const DEFAULT_CSAM_HOLD_FILTERS: CsamHoldFilters = { status: 'pending', sort: 'oldest' };

export const CSAM_HOLD_STATUS_LABELS: Record<CsamHoldStatusFilter, string> = {
  pending: 'Pending',
  'lead-review': 'Lead review',
  removed: 'Removed',
  'report-not-filed': 'Report not filed',
  dismissed: 'Dismissed',
  all: 'All',
};

export const CSAM_HOLD_SORT_LABELS: Record<CsamHoldSort, string> = {
  oldest: 'Oldest first',
  newest: 'Newest first',
};

export const csamHoldFilterParams = (
  filters: CsamHoldFilters,
  entityType?: string | null
): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const k of ['status', 'sort'] as const)
    if (filters[k] !== DEFAULT_CSAM_HOLD_FILTERS[k]) params[k] = filters[k];
  if (entityType) params.entityType = entityType;
  return params;
};
