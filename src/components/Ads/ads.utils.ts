import { useRef } from 'react';
import { getRandom } from '~/utils/array-helpers';
import { getRandomInt } from '~/utils/number-helpers';

export type AdFeedItem<T> = { type: 'data'; data: T } | { type: 'ad'; data: AdUnitDetail };
export type AdFeed<T> = AdFeedItem<T>[];

type AdMatrix = {
  indices: Array<{ index: number } & AdUnitDetail>;
  lastIndex: number;
};

export function useCreateAdFeed() {
  const adMatricesRef = useRef<Record<string, AdMatrix>>({});

  return function createAdFeed<T>({
    data,
    columnCount,
    keys,
  }: {
    data: T[];
    columnCount: number;
    /** pass multiple keys to randomize the adunits */
    keys?: AdUnitKey[];
  }) {
    const interval =
      adDensity.find(([columns]) => columns === columnCount)?.[1] ??
      adDensity[adDensity.length - 1][1];
    if (!keys || !interval) return data.map((data) => ({ type: 'data', data })) as AdFeed<T>;
    const key = interval.join('_');
    adMatricesRef.current[key] = adMatricesRef.current[key] ?? { indices: [], lastIndex: 0 };
    const adMatrix = adMatricesRef.current[key];

    const [lower, upper] = interval;
    while (adMatrix.lastIndex < data.length) {
      const min = adMatrix.lastIndex + lower + 1;
      const max = adMatrix.lastIndex + upper;
      const index = adMatrix.indices.length === 0 ? getRandomInt(3, 5) : getRandomInt(min, max);
      const items = getAdUnitDetails(keys);
      const item = getRandom(items);
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
  [2, [6, 9]],
  [3, [7, 10]],
  [4, [7, 11]],
  [5, [8, 12]],
  [6, [9, 14]],
  [7, [10, 16]],
];

const adDefinitions = {
  // '970x250:Leaderboard_A': 'civitaicom47456', // not using
  // '320x50:Leaderboard_A': 'civitaicom47760', // not using

  // '970x250:Leaderboard_B': 'civitaicom47457', // not using
  // '320x50:Leaderboard_B': 'civitaicom47761', // not using

  '970x250:Dynamic_Leaderboard': 'civitaicom47458',
  '320x50:Dynamic_Leaderboard': 'civitaicom47762',

  '300x250:Dynamic_Feeds': 'civitaicom47455',
  '300x600:Dynamic_Feeds': 'civitaicom47453',

  '300x250:model_image_pages': 'civitaicom47763',
  '728x90:Leaderboard': 'civitaicom47842',

  '300x250:Sidebar_A': 'civitaicom47459',
  // '300x250:Sidebar_B': 'civitaicom47460', // not using

  '300x600:StickySidebar_A': 'civitaicom47453',
  // '300x600:StickySidebar_B': 'civitaicom47454', // not using
};

const adDefinitionsGreen = {
  '970x250:Dynamic_Leaderboard': 'civitaigreen47881',
  '728x90:Dynamic_Leaderboard': 'civitaigreen47885',
  '320x50:Dynamic_Leaderboard': 'civitaigreen47884',

  '300x250:Dynamic_Feeds': 'civitaigreen47879',

  '300x250:model_image_pages': 'civitaigreen47880',

  '300x600:StickySidebar_A': 'civitaigreen47882',
};

// const adDefinitionKeys = Object.keys(adDefinitions) as AdDefinitionKey[];

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
  const config = getAdConfig();
  let adunitKeys: AdDefinitionKey[] = [];
  const keys = args
    .reduce<AdDefinitionKey[]>((acc, adUnitKey) => {
      if (adUnitKey in config.adunits) return [...acc, adUnitKey as AdDefinitionKey];
      if (!adunitKeys.length) adunitKeys = Object.keys(config.adunits) as AdDefinitionKey[];
      return [...acc, ...adunitKeys.filter((key) => key.includes(adUnitKey))];
    }, [])
    .sort()
    .reverse();

  return keys.map((key) => {
    const [size, name] = key.split(':');
    const [width, height] = size.split('x').map(Number);
    const type = name.includes('Dynamic') ? ('dynamic' as const) : ('static' as const);
    return {
      width,
      height,
      key,
      type,
      id: config.adunits[key],
    };
  });
}

export type AdConfig = { cmpScript: string; adScript: string; adunits: Record<string, string> };
const adConfig: Record<string, AdConfig> = {
  'civitai.com': {
    cmpScript: 'https://cmp.uniconsent.com/v2/a635bd9830/cmp.js',
    adScript: '//dsh7ky7308k4b.cloudfront.net/publishers/civitaicom.min.js',
    adunits: adDefinitions,
  },
  'civitai.green': {
    cmpScript: 'https://cmp.uniconsent.com/v2/7d36e04838/cmp.js',
    adScript: '//dsh7ky7308k4b.cloudfront.net/publishers/civitaigreen.min.js',
    adunits: adDefinitionsGreen,
  },
};

const defaultAdConfig = 'civitai.com';
export function getAdConfig() {
  return typeof window !== 'undefined'
    ? adConfig[location.host] ?? adConfig[defaultAdConfig]
    : adConfig[defaultAdConfig];
}
