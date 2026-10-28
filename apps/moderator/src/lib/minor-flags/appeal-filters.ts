export const APPEAL_SOURCES = ['all', 'text-scan', 'hash', 'moderator'] as const;
export const APPEAL_FLAGS = ['all', 'minor', 'poi', 'lock'] as const;
export const APPEAL_SORTS = ['oldest', 'newest', 'flagged'] as const;

export type AppealSource = (typeof APPEAL_SOURCES)[number];
export type AppealFlag = (typeof APPEAL_FLAGS)[number];
export type AppealSort = (typeof APPEAL_SORTS)[number];
/** Where a row's flag came from. `none` is a row label only, not a filter: those appeals list under All. */
export type FlagSourceKey = Exclude<AppealSource, 'all'> | 'none';

export type AppealFilters = { source: AppealSource; flag: AppealFlag; sort: AppealSort };

export const DEFAULT_APPEAL_FILTERS: AppealFilters = { source: 'all', flag: 'all', sort: 'oldest' };

/** The `Model.meta.minorFlagSnapshot.source` value each filter option selects. Any other value,
 *  including no snapshot at all, is `none`. */
export const SNAPSHOT_SOURCE = {
  'text-scan': 'text-scan',
  hash: 'auto',
  moderator: 'manual',
} as const;

export const sourceKey = (snapshotSource: string | null): FlagSourceKey => {
  for (const key of Object.keys(SNAPSHOT_SOURCE) as (keyof typeof SNAPSHOT_SOURCE)[])
    if (SNAPSHOT_SOURCE[key] === snapshotSource) return key;
  return 'none';
};

export const SOURCE_LABELS: Record<AppealSource | FlagSourceKey, string> = {
  all: 'All',
  'text-scan': 'Text scan',
  hash: 'Hash match',
  moderator: 'Moderator',
  none: 'No flag record',
};

export const FLAG_LABELS: Record<AppealFlag, string> = {
  all: 'All',
  minor: 'Minor',
  poi: 'Real person',
  lock: 'Locked setting',
};

export const SORT_LABELS: Record<AppealSort, string> = {
  oldest: 'Oldest appeal',
  newest: 'Newest appeal',
  flagged: 'Recently flagged',
};

/** A moderator affirming an auto or text-scan flag rewrites the source to `manual`, so `confirmedFrom`
 *  is the only trace of what started it. */
export const effectiveSource = (
  snapshotSource: string | null,
  confirmedFrom: string | null
): FlagSourceKey => {
  const key = sourceKey(snapshotSource);
  if (key !== 'moderator') return key;
  const origin = sourceKey(confirmedFrom);
  return origin === 'hash' || origin === 'text-scan' ? origin : key;
};

export const sourceLabel = (
  snapshotSource: string | null,
  confirmedFrom: string | null
): string => {
  const label = SOURCE_LABELS[sourceKey(snapshotSource)];
  const origin = effectiveSource(snapshotSource, confirmedFrom);
  return sourceKey(snapshotSource) === 'moderator' && origin !== 'moderator'
    ? `${label} (was ${SOURCE_LABELS[origin].toLowerCase()})`
    : label;
};

export const matchesFlag = (
  flag: AppealFlag,
  state: { minor: boolean; poi: boolean; lockReview?: boolean }
): boolean =>
  flag === 'all' ||
  (flag === 'minor' && state.minor) ||
  (flag === 'poi' && state.poi) ||
  (flag === 'lock' && !!state.lockReview);

export type AppealGroup = {
  source: string | null;
  minor: boolean;
  poi: boolean;
  lockReview: boolean;
  count: number;
};

export type AppealFacets = {
  source: Record<AppealSource, number>;
  flag: Record<AppealFlag, number>;
};

/** Each chip row counts under the OTHER row's selection, so no query per chip. */
export function appealFacets(groups: AppealGroup[], filters: AppealFilters): AppealFacets {
  const source = Object.fromEntries(APPEAL_SOURCES.map((s) => [s, 0])) as AppealFacets['source'];
  const flag = Object.fromEntries(APPEAL_FLAGS.map((f) => [f, 0])) as AppealFacets['flag'];
  for (const g of groups) {
    const key = sourceKey(g.source);
    if (matchesFlag(filters.flag, g)) {
      source.all += g.count;
      if (key !== 'none') source[key] += g.count;
    }
    if (filters.source === 'all' || filters.source === key) {
      for (const f of APPEAL_FLAGS) if (matchesFlag(f, g)) flag[f] += g.count;
    }
  }
  return { source, flag };
}

export const appealFilterParams = (filters: AppealFilters): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const k of ['source', 'flag', 'sort'] as const)
    if (filters[k] !== DEFAULT_APPEAL_FILTERS[k]) params[k] = filters[k];
  return params;
};
