import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';

export type BrowsingSettingsAddon = {
  type: 'all' | 'some' | 'none';
  nsfwLevels: NsfwLevel[];
  disablePoi?: boolean;
  disableMinor?: boolean;
  excludedTagIds?: number[];
  generationDefaultValues?: { denoise?: number };
  generationMinValues?: { denoise?: number };
  excludedFooterLinks?: string[];
};

export type ResolvedBrowsingSettingsAddons = {
  disablePoi: boolean;
  disableMinor: boolean;
  excludedTagIds: number[];
  excludedFooterLinks: string[];
  generationDefaultValues: { denoise?: number };
  generationMinValues: { denoise?: number };
};

function emptyResolvedAddons(): ResolvedBrowsingSettingsAddons {
  return {
    disablePoi: false,
    disableMinor: false,
    excludedTagIds: [],
    excludedFooterLinks: [],
    generationDefaultValues: {},
    generationMinValues: {},
  };
}

/**
 * Resolve the active addon list down to a flat settings object for a given
 * browsing level. Pure + isomorphic so the client provider and SSR prefetch
 * (which must reproduce the same `image.getInfinite` query key) share one
 * source of truth. Moderators bypass all addons.
 */
export function resolveBrowsingSettingsAddons(
  data: BrowsingSettingsAddon[],
  browsingLevel: number,
  opts?: { isModerator?: boolean }
): ResolvedBrowsingSettingsAddons {
  if (opts?.isModerator) return emptyResolvedAddons();

  return data.reduce((acc, elem) => {
    try {
      const intersection = Flags.intersection(
        browsingLevel,
        Flags.arrayToInstance(elem.nsfwLevels)
      );
      let apply = false;
      if (elem.type === 'some') apply = intersection !== 0;
      if (elem.type === 'all') apply = intersection === Flags.arrayToInstance(elem.nsfwLevels);
      if (elem.type === 'none') apply = intersection === 0;

      if (apply) {
        // booleans: last-explicit-wins. arrays: accumulate. A later rule
        // setting disablePoi/disableMinor=false cannot undo excludedTagIds
        // pushed by an earlier rule — scope rules narrowly instead.
        if (elem.disablePoi !== undefined) acc.disablePoi = elem.disablePoi;
        if (elem.disableMinor !== undefined) acc.disableMinor = elem.disableMinor;
        acc.excludedTagIds.push(...(elem.excludedTagIds ?? []));
        acc.excludedFooterLinks.push(...(elem.excludedFooterLinks ?? []));
        acc.generationDefaultValues = {
          ...acc.generationDefaultValues,
          ...(elem.generationDefaultValues ?? {}),
        };
        acc.generationMinValues = {
          ...acc.generationMinValues,
          ...(elem.generationMinValues ?? {}),
        };
      }
      return acc;
    } catch (error) {
      console.error('Error evaluating browsing settings addon:', error);
      return acc;
    }
  }, emptyResolvedAddons());
}

// Seed for the hard navigation blocklist (W2). The redis key
// `system:blocked-browsing-tags` overrides this when present; ops manage the
// live list there without a deploy. Kept in sync with the POI + minor
// `excludedTagIds` in DEFAULT_BROWSING_SETTINGS_ADDONS below.
export const BLOCKED_BROWSING_TAG_IDS: number[] = [
  5161, //actor
  5162, //actress
  5188, //celebrity
  5249, //real person
  130818, //porn actress
  130820, //adult actress
  133182, //porn star
  130401, //deepfake
  110980, //public figure
  5351, //child
  306619, //child present
  154326, //toddler
  161829, //male child
  163032, //female child
  114467, //loli
  6641, //shota
  115249, //teenager
];

export const DEFAULT_BROWSING_SETTINGS_ADDONS: BrowsingSettingsAddon[] = [
  {
    type: 'none',
    nsfwLevels: [NsfwLevel.X, NsfwLevel.XXX],
    excludedFooterLinks: ['2257'],
  },
  {
    type: 'some',
    nsfwLevels: [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
    disablePoi: true,
    excludedTagIds: [
      5161, //actor
      5162, //actress
      5188, //celebrity
      5249, //real person
      130818, //porn actress
      130820, //adult actress
      133182, //porn star
      130401, //deepfake
      110980, //public figure
    ],
  },
  {
    type: 'some',
    nsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
    disableMinor: true,
    excludedTagIds: [
      5351, //child
      306619, //child present
      154326, //toddler
      161829, //male child
      163032, //female child
    ],
  },
  {
    type: 'some',
    nsfwLevels: [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
    excludedTagIds: [
      114467, //loli
      6641, //shota
      115249, //teenager
    ],
  },
] as const;
