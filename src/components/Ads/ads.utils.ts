import { useMemo } from 'react';
import { useAscendeumAdsContext } from '~/components/Ads/AscendeumAds/AscendeumAdsProvider';
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
  interval,
  showAds,
}: {
  data: T[];
  interval?: number[];
  showAds?: boolean;
}): AdFeed<T> {
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
      acc.push({ type: 'ad', data: { adunit: 'Dynamic_InContent', height: 250 + 20, width: 300 } });
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

export const adsterraSizes = ['300x250', '728x90', '160x600'] as const;
export const adsterraSizeMap = {
  '300x250': ['300x100', '300x250'],
  '728x90': ['728x90', '970x90', '970x250'],
  '160x600': ['160x600', '300x600'],
};
export const adsterraAdSizeIdMap = {
  '300x250': 'cc4a2e648e7b1e739697da2e01bd806c',
  '728x90': '7ee748b62d78221dca7581833380d99f',
  '160x600': '73f599948b7a8ec86f222c10c6bf6291',
};
export const getAdsterraSize = (size: string): (typeof adsterraSizes)[0] | undefined => {
  return Object.entries(adsterraSizeMap).find(([key, sizes]) => sizes.includes(size))?.[0] as any;
};
