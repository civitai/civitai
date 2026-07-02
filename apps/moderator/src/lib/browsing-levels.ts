// Numeric (bitwise) NSFW levels — mirror of the main app's `~/server/common/enums` NsfwLevel and
// `~/shared/constants/browsingLevel.constants`. These are stable app constants, not Prisma enums, so
// @civitai/db-schema doesn't carry them; re-authored here (client-safe, no server deps).
export const NsfwLevel = {
  PG: 1,
  PG13: 2,
  R: 4,
  X: 8,
  XXX: 16,
  Blocked: 32,
} as const;

export const browsingLevels = [
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
] as const;

const browsingLevelLabels: Record<number, string> = {
  0: '?',
  [NsfwLevel.PG]: 'PG',
  [NsfwLevel.PG13]: 'PG-13',
  [NsfwLevel.R]: 'R',
  [NsfwLevel.X]: 'X',
  [NsfwLevel.XXX]: 'XXX',
  [NsfwLevel.Blocked]: 'Blocked',
};

// Highest-severity bit first — a composite level labels by its most severe bit.
const bitsBySeverity = [
  NsfwLevel.Blocked,
  NsfwLevel.XXX,
  NsfwLevel.X,
  NsfwLevel.R,
  NsfwLevel.PG13,
  NsfwLevel.PG,
];

export function getBrowsingLevelLabel(value: number | null | undefined): string {
  if (!value) return '?';
  const direct = browsingLevelLabels[value];
  if (direct) return direct;
  const highest = bitsBySeverity.find((bit) => (value & bit) !== 0);
  return highest ? browsingLevelLabels[highest] : '?';
}

// Single-bit levels a moderator can pin an article to (excludes Blocked; that's a TOS action, not a
// rating). The resolve callback re-validates server-side.
export const validNsfwLevels = new Set<number>(browsingLevels);

// Ingestion-error review lets a moderator set any browsing level OR Blocked (a mis-ingested image may be
// TOS-violating), so this set is broader than validNsfwLevels.
export const ingestionErrorLevels = [...browsingLevels, NsfwLevel.Blocked] as const;
export const ingestionErrorLevelSet = new Set<number>(ingestionErrorLevels);
