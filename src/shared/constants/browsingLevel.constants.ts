import { NsfwLevel } from '~/server/common/enums';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { Flags } from '~/shared/utils/flags';

export function parseBitwiseBrowsingLevel(level: number): number[] {
  return Flags.instanceToArray(level);
}

export function flagifyBrowsingLevel(levels: number[]) {
  return Flags.arrayToInstance(levels);
}

export const orchestratorNsfwLevelMap: Record<string, NsfwLevel> = {
  pg: NsfwLevel.PG,
  pg13: NsfwLevel.PG13,
  'pg-13': NsfwLevel.PG13,
  r: NsfwLevel.R,
  x: NsfwLevel.X,
  xxx: NsfwLevel.XXX,
};

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

// public browsing levels
export const publicBrowsingLevelsArray: BrowsingLevel[] = [NsfwLevel.PG];
export const publicBrowsingLevelsFlag = flagifyBrowsingLevel(publicBrowsingLevelsArray);

export const sfwBrowsingLevelsArray: BrowsingLevel[] = [NsfwLevel.PG, NsfwLevel.PG13];
export const sfwBrowsingLevelsFlag = flagifyBrowsingLevel(sfwBrowsingLevelsArray);

// nsfw browsing levels
export const nsfwBrowsingLevelsArray: NsfwLevel[] = [
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
  NsfwLevel.Blocked,
];

// Order matters: highest-severity bit first. `getHighestBrowsingLevelBit`
// returns the most severe single-bit value contained in a composite, which
// is what `getBrowsingLevelLabel` uses to label aggregate levels (e.g.
// comic projects bit_or all chapter levels — a composite of PG | R = 5
// has no direct entry in `browsingLevelLabels`).
const browsingLevelBitsBySeverity: NsfwLevel[] = [
  NsfwLevel.Blocked,
  NsfwLevel.XXX,
  NsfwLevel.X,
  NsfwLevel.R,
  NsfwLevel.PG13,
  NsfwLevel.PG,
];

export function getHighestBrowsingLevelBit(value: number): NsfwLevel | 0 {
  for (const bit of browsingLevelBitsBySeverity) {
    if ((value & bit) !== 0) return bit;
  }
  return 0;
}

export function getBrowsingLevelLabel(value: number) {
  // Fast path: single-bit values (or 0) hit the table directly.
  const direct = browsingLevelLabels[value as keyof typeof browsingLevelLabels];
  if (direct) return direct;
  // Composite (e.g. comic projects): label by the most severe bit
  // present, otherwise fall back to '?' for truly unrated.
  const highest = getHighestBrowsingLevelBit(value);
  return highest ? browsingLevelLabels[highest] : '?';
}
export const nsfwBrowsingLevelsFlag = flagifyBrowsingLevel(nsfwBrowsingLevelsArray);

// all browsing levels
export const allBrowsingLevelsFlag = flagifyBrowsingLevel([...browsingLevels]);

/**
 * App Blocks maturity policy — the SINGLE SOURCE OF TRUTH mapping a color
 * domain to the maximum browsing-level flag content rendered/generated inside a
 * block on that domain may carry.
 *
 * PRODUCT DECISION (App-Blocks-scoped): BOTH `green` AND `blue` clamp to SFW
 * (PG + PG-13); only `red` permits mature output. This DELIBERATELY differs
 * from the site-wide `canViewNsfw` feature flag, which today is TRUE on `blue`
 * (the main site treats blue as a mature domain). Blocks lead the platform
 * here: until the site-wide blue→SFW flip lands as a separate platform change,
 * the App-Blocks generation/catalog belts enforce blue=SFW on their own. Change
 * the policy in ONE place — this function — and the token-mint claim, the
 * generation clamp, the prompt-audit, and the BLOCK_INIT signal all follow.
 *
 * Returned value is a bitwise browsing-level flag (see `NsfwLevel`):
 *   - green → SFW  (PG + PG-13)              `sfwBrowsingLevelsFlag`
 *   - blue  → SFW  (PG + PG-13) [product]    `sfwBrowsingLevelsFlag`
 *   - red   → all levels (no clamp)          `allBrowsingLevelsFlag`
 *
 * Unknown / undefined domain → FAIL CLOSED to SFW (the most restrictive
 * non-empty ceiling). Callers must never widen on ambiguity.
 */
export function domainBrowsingCeiling(color: ColorDomain | undefined | null): number {
  switch (color) {
    case 'red':
      return allBrowsingLevelsFlag;
    case 'green':
    case 'blue':
      return sfwBrowsingLevelsFlag;
    default:
      // Fail closed: an unknown/missing domain gets the most restrictive ceiling.
      return sfwBrowsingLevelsFlag;
  }
}

/**
 * Derive whether mature (NSFW) generation output is permitted for a given
 * browsing-level ceiling. Mirrors the orchestrator's `allowMatureContent`
 * semantics (orchestrator.router.ts): `false` hard-blocks mature output,
 * `undefined` leaves it to the caller/orchestrator default (red domain).
 *
 * A ceiling that contains NO nsfw bits (SFW domains) → `false` (block mature).
 * A ceiling that contains any nsfw bit (red) → `undefined` (no clamp).
 */
export function allowMatureContentForCeiling(maxBrowsingLevel: number): boolean | undefined {
  return Flags.intersects(maxBrowsingLevel, nsfwBrowsingLevelsFlag) ? undefined : false;
}

// helpers
export function onlySelectableLevels(level: number) {
  if (Flags.hasFlag(level, NsfwLevel.Blocked)) level = Flags.removeFlag(level, NsfwLevel.Blocked);
  return level;
}

export function getIsPublicBrowsingLevel(level: number) {
  const levels = parseBitwiseBrowsingLevel(level);
  return levels.every((level) => publicBrowsingLevelsArray.includes(level));
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
  return level !== 0 && Flags.intersects(level, explicitBrowsingLevelFlags);
}

export const browsingLevelOr = (array: (number | undefined)[]) => {
  for (const item of array) {
    if (!!item) return item;
  }
  return publicBrowsingLevelsFlag;
};

export enum NsfwLevelDeprecated {
  None = 'None',
  Soft = 'Soft',
  Mature = 'Mature',
  X = 'X',
  Blocked = 'Blocked',
}
export const nsfwLevelMapDeprecated = {
  None: NsfwLevel.PG,
  Soft: flagifyBrowsingLevel([NsfwLevel.PG, NsfwLevel.PG13]),
  Mature: flagifyBrowsingLevel([NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R]),
  X: flagifyBrowsingLevel([NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX]),
  Blocked: NsfwLevel.Blocked,
};
const nsfwLevelReverseMapDeprecated = {
  [NsfwLevel.PG]: NsfwLevelDeprecated.None,
  [NsfwLevel.PG13]: NsfwLevelDeprecated.Soft,
  [NsfwLevel.R]: NsfwLevelDeprecated.Mature,
  [NsfwLevel.X]: NsfwLevelDeprecated.X,
  [NsfwLevel.XXX]: NsfwLevelDeprecated.X,
  [NsfwLevel.Blocked]: NsfwLevelDeprecated.Blocked,
};

export const getNsfwLevelDeprecatedReverseMapping = (level: number) => {
  return nsfwLevelReverseMapDeprecated[level as NsfwLevel] ?? NsfwLevelDeprecated.None;
};

export const nsfwLevelColors: Record<number, string> = {
  [NsfwLevel.PG]: 'green',
  [NsfwLevel.PG13]: 'yellow',
  [NsfwLevel.R]: 'orange',
  [NsfwLevel.X]: 'red',
  [NsfwLevel.XXX]: 'grape',
};

export const votableTagColors = {
  [0]: { dark: { color: 'gray', shade: 5 }, light: { color: 'gray', shade: 3 } },
  [NsfwLevel.PG]: { dark: { color: 'gray', shade: 5 }, light: { color: 'gray', shade: 3 } },
  [NsfwLevel.PG13]: { dark: { color: 'yellow', shade: 5 }, light: { color: 'yellow', shade: 3 } },
  [NsfwLevel.R]: { dark: { color: 'red', shade: 9 }, light: { color: 'red', shade: 6 } },
  [NsfwLevel.X]: { dark: { color: 'red', shade: 9 }, light: { color: 'red', shade: 6 } },
  [NsfwLevel.XXX]: { dark: { color: 'red', shade: 9 }, light: { color: 'red', shade: 6 } },
  [NsfwLevel.Blocked]: { dark: { color: 'red', shade: 9 }, light: { color: 'red', shade: 6 } },
} as const;

export const toggleableBrowsingCategories = [
  {
    title: 'Hide anime',
    relatedTags: [
      { id: 4, name: 'anime' },
      { id: 413, name: 'manga' },
      // { id: 5218, name: 'hentai' },
    ],
  },
  {
    title: 'Hide furry',
    relatedTags: [
      { id: 5139, name: 'anthro' },
      { id: 5140, name: 'furry' },
    ],
  },
  {
    title: 'Hide gore',
    relatedTags: [
      { id: 1282, name: 'gore' },
      { id: 789, name: 'body horror' },
    ],
  },
  {
    title: 'Hide political',
    relatedTags: [{ id: 2470, name: 'political' }],
  },
];

export const browsingModeDefaults = {
  showNsfw: false,
  blurNsfw: true,
  browsingLevel: publicBrowsingLevelsFlag,
};

export const browsingLevelReasons = {
  [NsfwLevel.Blocked]: ['Violates terms of service'],
  [NsfwLevel.XXX]: [
    'Sexual intercourse or penetration',
    'Visible handjob',
    'Visible oral sex (fellatio)',
    'Visible oral sex (cunnilingus / analingus)',
    'Hidden / implied masturbation or handjob',
    'Explicit breast/genital interaction',
    'Visible masturbation',
    'Visible ejaculation or bodily fluids',
    'BDSM or bondage content',
    'Tentacle-related sexual content',
    'Extreme close-ups of stretched orifices',
    'Vore',
    'Inflation with insertion',
  ],
  [NsfwLevel.X]: [
    'Exposed genitalia',
    'Visible genitals through clothing gaps',
    'Extreme upskirt or crotch focus',
    'Explicit genital focus, even if partially covered',
    'Visible erection',
  ],
  [NsfwLevel.R]: [
    'Visible uncovered female nipples or areolas',
    'Full exposed buttocks',
    'Adult toys or paraphernalia',
    'Suggestive lingerie without outer clothing',
    'Prominent genital outline through clothing',
    'See-through wet clothing revealing anatomy',
    'Sexually suggestive poses with clothing',
    'Standard bikini / two-piece swimwear',
    'Micro or thong swimwear baring anatomy',
    'Breasts spilling out of clothing / extreme cleavage',
    'Inflation without insertion',
  ],
  [NsfwLevel.PG13]: [
    'Excessive cleavage display',
    'Exaggerated sexual body proportions',
    'Sexualized topless / bare-chested male',
    'Revealing or minimal clothing coverage',
    'One-piece swimwear, trunks, or undergarments',
    'Excessively tight clothing',
    'Visible subtle bulges',
    'Visible nipple outlines',
    'Kink clothing (suggestive latex, bondage harness without nudity)',
    'Foot fetish framing',
    'Sexualized pregnancy',
    'Significant non-gore blood',
    'Profanity or explicit text in image',
  ],
  [NsfwLevel.PG]: [
    'Fully clothed content',
    'Fully clothed with midriff exposed',
    'Non-sexualized topless / bare-chested male',
    'Above-shoulder portraits',
    'Safe for work content',
    'All-ages appropriate content',
  ],
};
