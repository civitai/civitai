import { NsfwLevel } from '~/server/common/enums';

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
