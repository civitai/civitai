import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils';

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
  [NsfwLevel.PG]: 'PG',
  [NsfwLevel.PG13]: 'PG-13',
  [NsfwLevel.R]: 'R',
  [NsfwLevel.X]: 'X',
  [NsfwLevel.XXX]: 'XXX',
  [NsfwLevel.Blocked]: 'Blocked',
} as const;

export const browsingLevelDescriptions = {
  [NsfwLevel.PG]: 'Safe for work. No naughty stuff',
  [NsfwLevel.PG13]: 'Revealing clothing, violence, or light gore',
  [NsfwLevel.R]: 'Adult themes and situations, partial nudity, graphic violence, or death',
  [NsfwLevel.X]: 'Graphic nudity, adult objects, or settings',
  [NsfwLevel.XXX]: 'Overtly sexual or disturbing graphic content',
} as const;

// public browsing levels
export const publicBrowsingLevelsArray: BrowsingLevel[] = [NsfwLevel.PG];
export const publicBrowsingLevelsFlag = flagifyBrowsingLevel(publicBrowsingLevelsArray);

export const sfwBrowsingLevelsArray: BrowsingLevel[] = [NsfwLevel.PG, NsfwLevel.PG13];
export const sfwBrowsingLevelsFlag = flagifyBrowsingLevel(sfwBrowsingLevelsArray);

// nsfw browsing levels
export const nsfwBrowsingLevelsArray: BrowsingLevel[] = [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX];
export const nsfwBrowsingLevelsFlag = flagifyBrowsingLevel(nsfwBrowsingLevelsArray);

// all browsing levels
export const allBrowsingLevelsFlag = flagifyBrowsingLevel([...browsingLevels]);

export function getIsPublicBrowsingLevel(level: number) {
  const levels = parseBitwiseBrowsingLevel(level);
  return levels.every((level) => publicBrowsingLevelsArray.includes(level));
}

export function getIsSafeBrowsingLevel(level: number) {
  return level !== 0 && !Flags.intersects(level, nsfwBrowsingLevelsFlag);
}

export function hasPublicBrowsingLevel(level: number) {
  return level !== 0 && Flags.intersects(publicBrowsingLevelsFlag, level);
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
  [0]: { color: 'gray', shade: 5 },
  [NsfwLevel.PG]: { color: 'gray', shade: 5 },
  [NsfwLevel.PG13]: { color: 'yellow', shade: 5 },
  [NsfwLevel.R]: { color: 'red', shade: 9 },
  [NsfwLevel.X]: { color: 'red', shade: 9 },
  [NsfwLevel.XXX]: { color: 'red', shade: 9 },
  [NsfwLevel.Blocked]: { color: 'red', shade: 9 },
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
