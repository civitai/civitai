import { useRef } from 'react';
import { getRandom } from '~/utils/array-helpers';
import { getRandomInt } from '~/utils/number-helpers';

export type AdFeedItem<T> = { type: 'data'; data: T } | { type: 'ad'; data: AdFeedConfig };
export type AdFeed<T> = AdFeedItem<T>[];

type AdMatrix = {
  indices: Array<{ index: number } & AdFeedConfig>;
  lastIndex: number;
};

type AdFeedConfig = {
  width: number;
  height: number;
  AdUnit: React.ComponentType<Record<string, unknown>>;
};

export function useCreateAdFeed() {
  const adMatricesRef = useRef<Record<string, AdMatrix>>({});

  return function createAdFeed<T>({
    data,
    columnCount,
    options,
  }: {
    data: T[];
    columnCount: number;
    /** pass multiple keys to randomize the adunits */
    options?: AdFeedConfig[];
  }) {
    const interval =
      adDensity.find(([columns]) => columns === columnCount)?.[1] ??
      adDensity[adDensity.length - 1][1];
    if (!options || !interval) return data.map((data) => ({ type: 'data', data })) as AdFeed<T>;
    const key = interval.join('_');
    adMatricesRef.current[key] = adMatricesRef.current[key] ?? { indices: [], lastIndex: 0 };
    const adMatrix = adMatricesRef.current[key];

    const [lower, upper] = interval;
    while (adMatrix.lastIndex < data.length) {
      const min = adMatrix.lastIndex + lower + 1;
      const max = adMatrix.lastIndex + upper;
      const index = adMatrix.indices.length === 0 ? getRandomInt(3, 5) : getRandomInt(min, max);
      const item = getRandom(options);
      adMatrix.indices.push({ index, ...item });
      adMatrix.lastIndex = index;
    }
    const indices = adMatrix.indices.map((x) => x.index);

    return data.reduce<AdFeed<T>>((acc, item, i) => {
      const adMatrixIndex = indices.indexOf(i);
      if (adMatrixIndex > -1) {
        acc.push({ type: 'ad', data: adMatrix.indices[adMatrixIndex] });
      }
      acc.push({ type: 'data', data: item });
      return acc;
    }, []);
  };
}

type AdDensity = [columns: number, interval: [min: number, max: number]];
const adDensity: AdDensity[] = [
  [1, [5, 7]],
  [2, [5, 7]],
  [3, [5, 8]],
  [4, [5, 9]],
  [5, [6, 9]],
  [6, [6, 9]],
  [7, [6, 9]],
];

// Neutral filenames/dir so adblock network filters don't match ad dimensions.
export const supportUsImages = [
  { width: 970, height: 250, src: '/images/creators/wide.jpg' },
  { width: 970, height: 90, src: '/images/creators/wide-thin.jpg' },
  { width: 728, height: 90, src: '/images/creators/long.jpg' },
  { width: 300, height: 600, src: '/images/creators/tall.jpg' },
  { width: 120, height: 600, src: '/images/creators/tall-thin.jpg' },
  { width: 300, height: 250, src: '/images/creators/box.jpg' },
  { width: 300, height: 100, src: '/images/creators/strip.jpg' },
  { width: 320, height: 100, src: '/images/creators/strip-wide.jpg' },
  { width: 320, height: 50, src: '/images/creators/strip-thin.jpg' },
];

// Largest image that fits the slot — tallest, then widest.
export function getSupportUsImage(maxWidth: number, maxHeight: number) {
  return supportUsImages
    .filter(({ width, height }) => width <= maxWidth && height <= maxHeight)
    .sort((a, b) => b.height - a.height || b.width - a.width)[0];
}

export const adUnitsLoaded: Record<string, boolean> = {};
