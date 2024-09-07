import { getRandomInt } from '~/utils/number-helpers';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AdFeedItem<T> = { type: 'data'; data: T } | { type: 'ad' };
export type AdFeed<T> = AdFeedItem<T>[];

type AdMatrix = {
  indices: number[];
  lastIndex: number;
};

const adMatrices: Record<string, AdMatrix> = {};

export function createAdFeed<T>({
  data,
  columnCount,
  showAds,
}: {
  data: T[];
  columnCount: number;
  showAds?: boolean;
}): AdFeed<T> {
  const interval =
    adDensity.find(([columns]) => columns === columnCount)?.[1] ??
    adDensity[adDensity.length - 1][1];
  if (!showAds || !interval) return data.map((data) => ({ type: 'data', data }));
  const key = interval.join('_');
  adMatrices[key] = adMatrices[key] ?? { indices: [], lastIndex: 0 };
  const adMatrix = adMatrices[key];

  const [lower, upper] = interval;
  while (adMatrix.lastIndex < data.length) {
    const min = adMatrix.lastIndex + lower + 1;
    const max = adMatrix.lastIndex + upper;
    const index = getRandomInt(min, max);
    adMatrix.indices.push(index);
    adMatrix.lastIndex = index;
  }

  return data.reduce<AdFeed<T>>((acc, item, i) => {
    if (adMatrix.indices.includes(i)) {
      acc.push({ type: 'ad' });
    }
    acc.push({ type: 'data', data: item });
    return acc;
  }, []);
}

export const useConsentManager = create<{ targeting?: boolean }>()(
  persist(() => ({}), { name: 'cookieConsent' })
);

type AdDensity = [columns: number, interval: [min: number, max: number]];
const adDensity: AdDensity[] = [
  [1, [5, 7]],
  [2, [6, 9]],
  [3, [7, 10]],
  [4, [8, 11]],
  [5, [9, 12]],
  [6, [10, 13]],
  [7, [12, 18]],
];

interface IAdUnit {
  type: string;
  breakpoints: {
    minWidth?: number;
    maxWidth?: number;
    sizes: string[] | string;
  }[];
}

// #region [ascendeum]
type AscendeumAdSizes = typeof ascendeumAdSizes;
export const ascendeumAdSizes = {
  leaderboard: ['728x90', '970x90', '970x250', '300x250', '300x100', '320x50', '320x100', '468x60'],
  sidebar: ['300x250', '336x280'],
  dynamicInContent: ['300x250', '336x280'],
  stickySidebar: ['300x600', '160x600', '120x600'],
} as const;

export type AscendeumAdUnitType = keyof AscendeumAdUnitSizeMap;
type AscendeumAdUnitSizeMap = {
  Leaderboard_A: AscendeumAdSizes['leaderboard'];
  Leaderboard_B: AscendeumAdSizes['leaderboard'];
  Leaderboard_C: AscendeumAdSizes['leaderboard'];
  Sidebar_A: AscendeumAdSizes['sidebar'];
  Sidebar_B: AscendeumAdSizes['sidebar'];
  Dynamic_InContent: AscendeumAdSizes['dynamicInContent'];
  StickySidebar_A: AscendeumAdSizes['stickySidebar'];
  StickySidebar_B: AscendeumAdSizes['stickySidebar'];
};
export interface AscendeumAdUnit<T extends AscendeumAdUnitType> extends IAdUnit {
  type: 'ascendeum';
  adunit: T;
  breakpoints: {
    minWidth?: number;
    maxWidth?: number;
    sizes: AscendeumAdUnitSizeMap[T][number][];
  }[];
}
// #endregion

// #region [exoclick]
export type ExoclickAdSizes = typeof exoclickAdSizes;
const exoclickAdSizes = ['900x250', '728x90', '300x250', '300x100', '300x500', '160x600'] as const;

export interface ExoclickAdUnit extends IAdUnit {
  type: 'exoclick';
  breakpoints: {
    minWidth?: number;
    maxWidth?: number;
    sizes: ExoclickAdSizes[number];
  }[];
}

export const exoclickAdunitSizeMap: Record<ExoclickAdSizes[number], string> = {
  '900x250': '5187102',
  '728x90': '5186882',
  '300x250': '5187018',
  '300x100': '5187104',
  '300x500': '5187110',
  '160x600': '5187116',
} as const;
// #endregion

// #region [placholder images]
export type AnyAdSize = (typeof allAdSizes)[number];
export const allAdSizes = [
  ...ascendeumAdSizes.dynamicInContent,
  ...ascendeumAdSizes.leaderboard,
  ...ascendeumAdSizes.sidebar,
  ...ascendeumAdSizes.stickySidebar,
  ...exoclickAdSizes,
] as const;

const placeholderImageSizes = [
  '120x600',
  '300x100',
  '300x250',
  '300x600',
  '728x90',
  '970x90',
  '970x250',
] as const;

const adPlaceholderImageSizes = [
  [120, 600],
  [300, 100],
  [300, 250],
  [300, 600],
  [728, 90],
  [970, 90],
  [970, 250],
] as const;

type TupleToObject<T extends readonly (readonly [number, number])[]> = {
  [K in keyof T]: { width: T[K][0]; height: T[K][1] };
}[number];
export type AdSizes = TupleToObject<typeof adPlaceholderImageSizes>;

export const adSizeImageMap: Record<AnyAdSize, (typeof placeholderImageSizes)[number]> = {
  '728x90': '728x90',
  '970x90': '970x90',
  '970x250': '970x250',
  '300x250': '300x250',
  '300x100': '300x100',
  '320x50': '300x100',
  '320x100': '300x100',
  '468x60': '300x100',
  '336x280': '300x250',
  '300x600': '300x600',
  '160x600': '120x600',
  '120x600': '120x600',
  '900x250': '970x250',
  '300x500': '300x600',
};

// #endregion

const adDefinitions = {
  '728x90:Leaderboard_A': 'civitaicom47456',
  '320x50:Leaderboard_A': 'civitaicom47760',
  '728x90:Leaderboard_B': 'civitaicom47457',
  '320x50:Leaderboard_B': 'civitaicom47761',
  '728x90:Leaderboard_C': 'civitaicom47458',
  '320x50:Leaderboard_C': 'civitaicom47762',
  '300x250:Dynamic_Feeds': 'civitaicom47455',
  '300x600:Dynamic_Feeds': 'civitaicom47453',
  '300x250:model_image_pages': 'civitaicom47763',
};
const adDefinitionKeys = Object.keys(adDefinitions) as AdDefinitionKey[];

type AdDefinitionKey = keyof typeof adDefinitions;

type Split<S extends string, D extends string> = string extends S
  ? string[]
  : S extends ''
  ? []
  : S extends `${infer T}${D}${infer U}`
  ? [T, ...Split<U, D>]
  : [S];

export type AdUnitKey = AdDefinitionKey | Split<AdDefinitionKey, ':'>[1];

export type AdUnitDetail = ReturnType<typeof getAdUnitDetails>[number];
export function getAdUnitDetails(args: AdUnitKey[]) {
  const keys = args
    .reduce<AdDefinitionKey[]>((acc, adUnitKey) => {
      if (adUnitKey in adDefinitions) return [...acc, adUnitKey as AdDefinitionKey];
      return [...acc, ...adDefinitionKeys.filter((key) => key.includes(adUnitKey))];
    }, [])
    .sort()
    .reverse();

  return keys.map((key) => {
    const [size, name] = key.split(':');
    const [width, height] = size.split('x').map(Number);
    const type = name === 'Dynamic_Feeds' ? ('dynamic' as const) : ('static' as const);
    return {
      width,
      height,
      key,
      type,
      id: adDefinitions[key],
    };
  });
}
