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
    excludedFooterLinks: [],
    disableMinor: true,
    disablePoi: true,
    excludedTagIds: [
      415792, // Clavata Celebrity
      426772, // Clavata Celebrity
      5351, //child
      5161, //actor
      5162, //actress
      5188, //celebrity
      5249, //real person
      306619, //child present
      5351, //child
      154326, //toddler
      161829, //male child
      163032, //female child
      130818, //porn actress
      130820, //adult actress
      133182, //porn star
    ],
  },
] as const;
