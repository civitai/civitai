import { add } from 'lodash';
import { getRandomInt } from '~/utils/number-helpers';

export type AdFeedItem<T> =
  | { type: 'data'; data: T }
  | { type: 'ad'; data: { adunit: AdUnitType; height: number; width: number } };
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
      acc.push({
        type: 'ad',
        data: {
          adunit: 'Dynamic_InContent',
          // + 20 to account for css padding
          height: 250 + 20,
          width: 300,
        },
      });
    }
    acc.push({ type: 'data', data: item });
    return acc;
  }, []);
}

export type AdSizeType = keyof typeof sizes;
export type AdSizes<T extends AdSizeType> = (typeof sizes)[T];

const sizes = {
  hero: ['728x90', '970x90', '970x250', '300x250', '300x100', '320x50', '320x100', '468x60'],
  inContent: ['300x250', '336x280'],
  stickySidebar: ['300x600', '160x600', '120x600'],
} as const;

type AdUnits = typeof adunits;
export type AdUnitType = keyof typeof adunits;
export type AdUnitSizes<T extends AdUnitType> = AdSizes<AdUnits[T]>;
export type AdUnitSize<T extends AdUnitType> = AdUnitSizes<T>[number];
export type AdUnitBidSizes<T extends AdUnitType> = AdUnitSize<T> | AdUnitSize<T>[];
const adunits = {
  Leaderboard_A: 'hero',
  Leaderboard_B: 'hero',
  Leaderboard_C: 'hero',
  Sidebar_A: 'inContent',
  Sidebar_B: 'inContent',
  Dynamic_InContent: 'inContent',
  StickySidebar_A: 'stickySidebar',
  StickySidebar_B: 'stickySidebar',
} as const;

export const exoclickSizes: Record<string, string> = {
  '900x250': '5187102',
  '728x90': '5186882',
  '300x250': '5187018',
  '300x100': '5187104',
  '300x500': '5187110',
  '160x600': '5187116',
};

export const ascendeumExoclickSizeMap: Record<string, string | null | undefined> = {
  '728x90': '728x90',
  '970x90': '728x90',
  '970x250': '900x250',
  '300x250': '300x250',
  '300x100': '300x100',
  '320x50': '300x100',
  '320x100': '300x100',
  '468x60': '300x100',
  '336x280': '300x250',
  '300x600': null,
  // '300x600': '300x500',
  // '300x600': '160x600',
  '160x600': '160x600',
  '120x600': null,
};

type AdDensity = [columns: number, interval: [min: number, max: number]];
const adDensity: AdDensity[] = [
  [1, [6, 10]],
  [2, [7, 12]],
  [3, [8, 14]],
  [4, [9, 15]],
  [5, [10, 16]],
  [6, [12, 18]],
  [7, [14, 20]],
];
