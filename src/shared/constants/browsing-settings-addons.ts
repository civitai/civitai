import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';

/**
 * Surfaces an addon entry can be limited to. An entry with no `scope` applies
 * everywhere, which is what every entry did before scopes existed.
 *
 * Kept as a runtime list, not just a type: the live entries are hand-edited JSON
 * in redis and parsed without a schema, so the type checks nothing at that
 * boundary.
 */
export const BROWSING_ADDON_SCOPES = ['newCreators'] as const;
export type BrowsingAddonScope = (typeof BROWSING_ADDON_SCOPES)[number];

export type BrowsingSettingsAddon = {
  type: 'all' | 'some' | 'none';
  nsfwLevels: NsfwLevel[];
  /**
   * Limit this entry to one surface. Omit for a global rule. Use this for
   * anything that should be hidden from discovery but stay visible where a user
   * asked for it by name — a global `excludedTagIds` also empties the tag's own
   * collection pages and home blocks, which fetch a fixed page and drop filtered
   * items without backfilling.
   */
  scope?: BrowsingAddonScope;
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
  opts?: { isModerator?: boolean; scope?: BrowsingAddonScope }
): ResolvedBrowsingSettingsAddons {
  if (opts?.isModerator) return emptyResolvedAddons();

  return data.reduce((acc, elem) => {
    try {
      if (elem.scope) {
        // A misspelled scope matches no surface, so the entry silently stops
        // applying anywhere. Say so — nothing validates the redis payload, and
        // moderators resolve to no addons at all, so nobody can spot it by eye.
        if (!BROWSING_ADDON_SCOPES.includes(elem.scope)) {
          console.error('Unrecognized browsing settings addon scope:', elem.scope);
          return acc;
        }
        if (elem.scope !== opts?.scope) return acc;
      }

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

// Seed for the hard navigation blocklist (W2) — blocks the tag page and nav, not the
// content carrying the tag. The redis key `system:blocked-browsing-tags` overrides this
// when present; ops manage the live list there without a deploy.
//
// Deliberately NOT a mirror of the addon `excludedTagIds` below: loli/shota/teenager are
// listed here but excluded from no addon, so their tag pages 404 while their content
// stays subject to the normal browsing-level rules. Hiding the content was WD14's call to
// make and it isn't good enough at it — 459,896 `loli` tags at ~59% average confidence,
// unreviewed. Don't "re-sync" the two lists.
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
] as const;
