import { Flags } from './flags';

// Numeric (bitwise) NSFW levels + the generic browsing-level toolkit — a faithful port of the reusable
// (non-product-specific) parts of the main app's `~/shared/constants/browsingLevel.constants` and its
// `~/server/common/enums` NsfwLevel. These are stable app constants, not Prisma enums, so @civitai/db-schema
// doesn't carry them. Client-safe (no server/env/framework deps) so any app can import them — server code,
// SvelteKit components, and the main Next app alike.
//
// DELIBERATELY EXCLUDED here (main-app / product / UI specific — keep those in the main app): the App-Blocks
// off-site content-rating ladder + domain ceilings, the orchestrator level map, the deprecated NsfwLevel
// enum + maps, Mantine color maps (nsfwLevelColors / votableTagColors), toggleable browsing categories,
// browsingModeDefaults, and the per-level moderation "reasons" copy.
export const NsfwLevel = {
  PG: 1,
  PG13: 2,
  R: 4,
  X: 8,
  XXX: 16,
  Blocked: 32,
} as const;

export function parseBitwiseBrowsingLevel(level: number): number[] {
  return Flags.instanceToArray(level);
}

export function flagifyBrowsingLevel(levels: number[]) {
  return Flags.arrayToInstance(levels);
}

export type BrowsingLevels = typeof browsingLevels;
export type BrowsingLevel = BrowsingLevels[number];
export const browsingLevels = [
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
] as const;

export const browsingLevelLabels = {
  0: '?',
  [NsfwLevel.PG]: 'PG',
  [NsfwLevel.PG13]: 'PG-13',
  [NsfwLevel.R]: 'R',
  [NsfwLevel.X]: 'X',
  [NsfwLevel.XXX]: 'XXX',
  [NsfwLevel.Blocked]: 'Blocked',
} as const;

export const browsingLevelDescriptions = {
  [NsfwLevel.PG]: 'Safe for work. No naughty stuff',
  [NsfwLevel.PG13]:
    'Revealing clothing, small bulges, subtle nipple outline, posing/sexualized bare chested men, light gore, violence',
  [NsfwLevel.R]:
    'Adult themes and situations, partial nudity, bikinis, big bulges, sexual situations, graphic violence',
  [NsfwLevel.X]: 'Graphic nudity, genitalia, adult objects, or settings',
  [NsfwLevel.XXX]:
    'Sexual Acts, masturbation, ejaculation, cum, vore, anal gape, extremely disturbing content',
  [NsfwLevel.Blocked]: 'Violates our terms of service',
} as const;

// Level groupings + their OR'd flags.
export const publicBrowsingLevelsArray: BrowsingLevel[] = [NsfwLevel.PG];
export const publicBrowsingLevelsFlag = flagifyBrowsingLevel(publicBrowsingLevelsArray);

export const sfwBrowsingLevelsArray: BrowsingLevel[] = [NsfwLevel.PG, NsfwLevel.PG13];
export const sfwBrowsingLevelsFlag = flagifyBrowsingLevel(sfwBrowsingLevelsArray);

export const nsfwBrowsingLevelsArray: number[] = [
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
  NsfwLevel.Blocked,
];
export const nsfwBrowsingLevelsFlag = flagifyBrowsingLevel(nsfwBrowsingLevelsArray);

// All rateable levels OR'd together — matches the main app's `allBrowsingLevelsFlag` (EXCLUDES Blocked;
// Blocked is a TOS action, not a rating).
export const allBrowsingLevelsFlag = flagifyBrowsingLevel([...browsingLevels]);

// All levels INCLUDING Blocked — for moderator contexts (e.g. a review-queue browsing filter that shows
// Blocked too). Distinct from `allBrowsingLevelsFlag` on purpose.
export const allBrowsingLevelsWithBlockedFlag = allBrowsingLevelsFlag | NsfwLevel.Blocked;

// Highest-severity bit first — `getHighestBrowsingLevelBit` returns the most severe single-bit value in a
// composite, which is what `getBrowsingLevelLabel` uses to label aggregate levels (e.g. a composite of
// PG | R = 5, which has no direct entry in `browsingLevelLabels`).
const browsingLevelBitsBySeverity: number[] = [
  NsfwLevel.Blocked,
  NsfwLevel.XXX,
  NsfwLevel.X,
  NsfwLevel.R,
  NsfwLevel.PG13,
  NsfwLevel.PG,
];

export function getHighestBrowsingLevelBit(value: number): number {
  for (const bit of browsingLevelBitsBySeverity) {
    if ((value & bit) !== 0) return bit;
  }
  return 0;
}

export function getBrowsingLevelLabel(value: number | null | undefined): string {
  if (!value) return '?';
  const direct = browsingLevelLabels[value as keyof typeof browsingLevelLabels];
  if (direct) return direct;
  const highest = getHighestBrowsingLevelBit(value);
  return highest ? browsingLevelLabels[highest as keyof typeof browsingLevelLabels] : '?';
}

// --- predicates / helpers ---

// Strip the Blocked bit (a TOS action, not a selectable rating); removeFlag is a no-op when it isn't set.
export function onlySelectableLevels(level: number) {
  return Flags.removeFlag(level, NsfwLevel.Blocked);
}

// True when `level` contains only public bits (its bits are a subset of publicBrowsingLevelsFlag).
export function getIsPublicBrowsingLevel(level: number) {
  return Flags.diff(level, publicBrowsingLevelsFlag) === 0;
}

/** does not include any nsfw level flags */
export function getIsSafeBrowsingLevel(level: number) {
  return level !== 0 && !Flags.intersects(level, nsfwBrowsingLevelsFlag);
}

/** includes a level suitable for public browsing */
export function hasPublicBrowsingLevel(level: number) {
  return Flags.hasFlag(level, publicBrowsingLevelsFlag);
}

export function hasSafeBrowsingLevel(level: number) {
  return Flags.intersects(level, sfwBrowsingLevelsFlag);
}

const explicitBrowsingLevelFlags = flagifyBrowsingLevel([
  NsfwLevel.X,
  NsfwLevel.XXX,
  NsfwLevel.Blocked,
]);
export function getHasExplicitBrowsingLevel(level: number) {
  return Flags.intersects(level, explicitBrowsingLevelFlags);
}

export const browsingLevelOr = (array: (number | undefined)[]) =>
  array.find((x) => !!x) ?? publicBrowsingLevelsFlag;

// --- moderator-facing level sets (used by the moderator app; not in the main app's constants) ---

// Single-bit levels a moderator can pin content to (excludes Blocked; that's a TOS action, not a rating).
// Callers should re-validate server-side.
export const validNsfwLevels = new Set<number>(browsingLevels);

// Ingestion-error review lets a moderator set any browsing level OR Blocked (a mis-ingested image may be
// TOS-violating), so this set is broader than validNsfwLevels.
export const ingestionErrorLevels = [...browsingLevels, NsfwLevel.Blocked] as const;
export const ingestionErrorLevelSet = new Set<number>(ingestionErrorLevels);
