import type { PermissionId, PermissionSet } from '$lib/permissions';
import type { FlagRef } from './flagged-decision';
import type { FlaggedFlag, FlaggedSort } from './flagged-filters';

/** Each kind of lead in Needs review is listed and ruled only for a viewer holding its permission. */
export const NEEDS_REVIEW_PERMISSIONS = {
  detections: 'modelFlags.detections.decide',
  matches: 'modelFlags.fileMatches.decide',
} as const satisfies Record<string, PermissionId>;

export type NeedsReviewSources = { detections: boolean; matches: boolean };

export const needsReviewSources = (grants: PermissionSet): NeedsReviewSources => ({
  detections: !!grants[NEEDS_REVIEW_PERMISSIONS.detections],
  matches: !!grants[NEEDS_REVIEW_PERMISSIONS.matches],
});

export const NEEDS_REVIEW_SOURCE_FILTERS = ['all', 'text-scan', 'hash'] as const;
export type NeedsReviewSourceFilter = (typeof NEEDS_REVIEW_SOURCE_FILTERS)[number];

export const NEEDS_REVIEW_SOURCE_LABELS: Record<NeedsReviewSourceFilter, string> = {
  all: 'All',
  'text-scan': 'Text scan',
  hash: 'Hash',
};

export type NeedsReviewFilters = {
  source: NeedsReviewSourceFilter;
  flag: FlaggedFlag;
  sort: FlaggedSort;
};

export const DEFAULT_NEEDS_REVIEW_FILTERS: NeedsReviewFilters = {
  source: 'all',
  flag: 'all',
  sort: 'oldest',
};

export const needsReviewFilterParams = (filters: NeedsReviewFilters): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const k of ['source', 'flag', 'sort'] as const)
    if (filters[k] !== DEFAULT_NEEDS_REVIEW_FILTERS[k]) params[k] = filters[k];
  return params;
};

/**
 * Which queries a Needs review list runs: the kinds the viewer holds, narrowed by the filters. File
 * matches are minor-only, so a real-person filter leaves them out.
 */
export const needsReviewBranches = (
  granted: NeedsReviewSources,
  { source, flag }: Pick<NeedsReviewFilters, 'source' | 'flag'>
): NeedsReviewSources => ({
  detections: granted.detections && source !== 'hash',
  matches: granted.matches && source !== 'text-scan' && flag !== 'poi',
});

/** The source chips worth offering: with only one kind held there is nothing to choose between. */
export const needsReviewSourceChips = (granted: NeedsReviewSources): NeedsReviewSourceFilter[] =>
  granted.detections && granted.matches ? [...NEEDS_REVIEW_SOURCE_FILTERS] : [];

export type ChipCounts<K extends string> = Partial<Record<K, number>>;

/** The numbers on the source chips, in models; a part that is unknown (timed out) drops its chip's
 *  count, and All's. Empty while the chips are not offered. */
export function needsReviewChipCounts(
  granted: NeedsReviewSources,
  parts: { detections: number | null; matches: number | null; overlap: number | null }
): ChipCounts<NeedsReviewSourceFilter> {
  if (!needsReviewSourceChips(granted).length) return {};
  const counts: ChipCounts<NeedsReviewSourceFilter> = {};
  const all = needsReviewTotal(granted, parts);
  if (all !== null) counts.all = all;
  if (parts.detections !== null) counts['text-scan'] = parts.detections;
  if (parts.matches !== null) counts.hash = parts.matches;
  return counts;
}

/** The sidebar counts are shared by everyone, so each viewer's badge reads the key for what they hold. */
export const NEEDS_REVIEW_COUNT_KEYS = {
  all: 'modelFlagsNeedsReview',
  detections: 'modelFlagsNeedsReviewDetections',
  matches: 'modelFlagsNeedsReviewMatches',
} as const;

export function needsReviewCountKey(granted: NeedsReviewSources): string | undefined {
  if (granted.detections && granted.matches) return NEEDS_REVIEW_COUNT_KEYS.all;
  if (granted.detections) return NEEDS_REVIEW_COUNT_KEYS.detections;
  if (granted.matches) return NEEDS_REVIEW_COUNT_KEYS.matches;
  return undefined;
}

/**
 * The Needs review badge in models: detections and matches each counted per model, less the models
 * that are both (one row on the page). Null when a part it needs is unknown.
 */
export function needsReviewTotal(
  granted: NeedsReviewSources,
  counts: { detections: number | null; matches: number | null; overlap: number | null }
): number | null {
  const { detections, matches, overlap } = counts;
  if (granted.detections && granted.matches)
    return detections === null || matches === null || overlap === null
      ? null
      : detections + matches - overlap;
  if (granted.detections) return detections;
  if (granted.matches) return matches;
  return 0;
}

/**
 * What a Needs review row's decision rules: its held detections, then its file match (a minor lead
 * with no text behind it). The order is the ruling order: a kept minor detection lands before
 * set-minor makes it a moderator's flag.
 */
export const leadRefs = (row: {
  flags: readonly Pick<FlagRef, 'label' | 'source' | 'textHash'>[];
  match: unknown;
}): FlagRef[] => [
  ...row.flags.map(({ label, source, textHash }) => ({ label, source, textHash })),
  ...(row.match
    ? [{ label: 'minor' as const, source: 'file-match' as const, textHash: null }]
    : []),
];
