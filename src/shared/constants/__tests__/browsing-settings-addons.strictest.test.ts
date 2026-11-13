import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type { BrowsingSettingsAddon } from '~/shared/constants/browsing-settings-addons';
import {
  DEFAULT_BROWSING_SETTINGS_ADDONS,
  resolveBrowsingSettingsAddons,
  resolveStrictestPoiMinor,
} from '~/shared/constants/browsing-settings-addons';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

// Every level a client within `levels` could browse at.
const clientLevels = (levels: number) => {
  const bits = Flags.instanceToArray(levels);
  return Array.from({ length: (1 << bits.length) - 1 }, (_, i) =>
    bits.reduce((acc, bit, j) => ((i + 1) & (1 << j) ? acc | bit : acc), 0)
  );
};

const mature = [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX];
const shapes: [string, BrowsingSettingsAddon[]][] = [
  ['the default rules', DEFAULT_BROWSING_SETTINGS_ADDONS],
  // On only while no mature level is selected.
  ['a "none" rule', [{ type: 'none', nsfwLevels: mature, disablePoi: true, disableMinor: true }]],
  // A later rule switches it back off once a mature level is selected.
  [
    'a later explicit false',
    [
      { type: 'some', nsfwLevels: [NsfwLevel.PG], disablePoi: true, disableMinor: true },
      { type: 'some', nsfwLevels: mature, disablePoi: false, disableMinor: false },
    ],
  ],
];

describe('resolveStrictestPoiMinor', () => {
  it.each(shapes)('is never looser than any client level for %s', (_label, data) => {
    const server = resolveStrictestPoiMinor(data, allBrowsingLevelsFlag);
    for (const level of clientLevels(allBrowsingLevelsFlag)) {
      const client = resolveBrowsingSettingsAddons(data, level);
      if (client.disablePoi) expect(server.disablePoi).toBe(true);
      if (client.disableMinor) expect(server.disableMinor).toBe(true);
    }
  });

  // A single resolution at every level at once, which these shapes defeat.
  it.each(shapes.slice(1))('is stricter than one resolution at all levels for %s', (_l, data) => {
    expect(resolveBrowsingSettingsAddons(data, allBrowsingLevelsFlag).disablePoi).toBe(false);
    expect(resolveStrictestPoiMinor(data, allBrowsingLevelsFlag).disablePoi).toBe(true);
  });

  it('resolves nothing for a moderator', () => {
    for (const [, data] of shapes)
      expect(resolveStrictestPoiMinor(data, allBrowsingLevelsFlag, { isModerator: true })).toEqual({
        disablePoi: false,
        disableMinor: false,
      });
  });
});
