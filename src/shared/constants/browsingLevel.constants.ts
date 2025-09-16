import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';

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

export function getBrowsingLevelLabel(value: number) {
  return browsingLevelLabels[value as keyof typeof browsingLevelLabels] ?? '?';
}
export const nsfwBrowsingLevelsFlag = flagifyBrowsingLevel(nsfwBrowsingLevelsArray);

// all browsing levels
export const allBrowsingLevelsFlag = flagifyBrowsingLevel([...browsingLevels]);

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
