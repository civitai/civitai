import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils';

export function parseBitwiseBrowsingLevel(level: number): number[] {
  return Flags.instanceToArray(level);
}

export function flagifyBrowsingLevel(levels: number[]) {
  return Flags.arrayToInstance(levels);
}

// #region [nsfw levels]
export const nsfwLevels = [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX];

export const nsfwLevelLabels = {
  [NsfwLevel.PG]: 'Safe',
  [NsfwLevel.PG13]: 'LG (lightly graphic)',
  [NsfwLevel.R]: 'MG (moderately graphic)',
  [NsfwLevel.X]: 'FG (fairly graphic)',
  [NsfwLevel.XXX]: 'VG (very graphic)',
  [NsfwLevel.Blocked]: 'Blocked',
};

export const nsfwLevelDescriptions = {
  [NsfwLevel.PG]: 'Content that can be viewed by anyone.',
  [NsfwLevel.PG13]: 'Content that requires consideration before sharing in professional setting',
  [NsfwLevel.R]: 'Content that contains some visually explicit scenes with moderate intensity',
  [NsfwLevel.X]: 'Content that is noticeably more detailed and intense',
  [NsfwLevel.XXX]:
    'Content that is extensive and explicit, with a high level of graphic detail and intensity',
};

export function getNsfwLevelDetails(nsfwLevel: number) {
  const name = nsfwLevelLabels[nsfwLevel as keyof typeof nsfwLevelLabels];
  const description = nsfwLevelDescriptions[nsfwLevel as keyof typeof nsfwLevelDescriptions];
  return { name, description };
}
// #endregion

// #region [browsing levels]
// browsing level groups
export const safeBrowsingLevels = flagifyBrowsingLevel([NsfwLevel.PG]);
export const nsfwBrowsingLevels = flagifyBrowsingLevel([NsfwLevel.PG13, NsfwLevel.R]);
export const graphicBrowsingLevels = flagifyBrowsingLevel([NsfwLevel.X, NsfwLevel.XXX]);
// all browsing levels
export const allBrowsingLevelsFlag = flagifyBrowsingLevel([...nsfwLevels]);

export function getVisibleBrowsingLevels(browsingLevel: number) {
  return browsingLevels.filter(
    (level) =>
      !Flags.intersects(level, graphicBrowsingLevels) ||
      Flags.intersects(browsingLevel, nsfwBrowsingLevels)
  );
}

export function deriveBrowsingLevel(level: number) {
  const hasNsfw = Flags.hasFlag(level, nsfwBrowsingLevels);
  const hasGraphic = Flags.hasFlag(level, graphicBrowsingLevels);
  if (!hasNsfw && hasGraphic) level = Flags.removeFlag(level, graphicBrowsingLevels);
  return level;
}

export function getIsDefaultBrowsingLevel(instance: number, level: number) {
  return instance === 0 && level === safeBrowsingLevels;
}

export const browsingLevels = [safeBrowsingLevels, nsfwBrowsingLevels, graphicBrowsingLevels];
const browsingLevelDetails = {
  [safeBrowsingLevels]: {
    name: 'Safe',
    description:
      'Features no obvious or visually detailed scenes of explicit material, making it suitable for all audiences.',
  },
  [nsfwBrowsingLevels]: {
    name: 'NSFW',
    description:
      ' Includes material that may not be acceptable for all audiences or all settings. ',
  },
  [graphicBrowsingLevels]: {
    name: 'NSFW+',
    description:
      'Content that is extensive and explicit, with a high level of graphic detail and intensity. Viewer discretion advised.',
  },
};
export function getBrowsingLevelDetails(level: number) {
  return browsingLevelDetails[level] ?? {};
}

/** get browsing level based on nsfwLevel with safe default */
export function getBrowsingLevel(nsfwLevel: number) {
  return browsingLevels.find((level) => Flags.hasFlag(level, nsfwLevel)) ?? safeBrowsingLevels;
}
// #endregion

// used on the home page to set the level of content we want to show
export const homePageBrowsingLevels = flagifyBrowsingLevel([NsfwLevel.PG, NsfwLevel.PG13]);
// used to draw the line on where we blur media content
export const blurrableBrowsingLevels = flagifyBrowsingLevel([
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
]);

// helpers
export function onlySelectableLevels(level: number) {
  if (Flags.hasFlag(level, NsfwLevel.Blocked)) level = Flags.removeFlag(level, NsfwLevel.Blocked);
  return level;
}

export function getIsPublicBrowsingLevel(level: number) {
  return Flags.hasFlag(safeBrowsingLevels, level);
}

export function getIsSafeBrowsingLevel(level: number) {
  return level !== 0 && !Flags.intersects(level, blurrableBrowsingLevels);
}

export function hasPublicBrowsingLevel(level: number) {
  return level !== 0 && Flags.intersects(safeBrowsingLevels, level);
}

export const browsingLevelOr = (array: (number | undefined)[]) => {
  for (const item of array) {
    if (!!item) return item;
  }
  return safeBrowsingLevels;
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
