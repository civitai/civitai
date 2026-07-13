import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  hasSafeBrowsingLevel,
  sfwBrowsingLevelsArray,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

// The `disableMinor` addon (fires at mature browsing levels) must hide minor-flagged
// rows ONLY when they are also mature. SFW minor content (PG / PG-13) stays visible.
// These predicates mirror the three enforcement dialects verbatim so a change to the
// SFW boundary (or a fail-open regression on NULL/0 nsfwLevel) trips the suite.

// SQL (Postgres): image/model services push
//   (minor != TRUE OR (nsfwLevel & sfwFlag) != 0)
// Postgres treats NULL nsfwLevel as unknown → row not returned (hidden), which we model
// by returning false for a NULL level.
const sqlKeepsRow = (minor: boolean, nsfwLevel: number | null) =>
  !minor || (nsfwLevel != null && (nsfwLevel & sfwBrowsingLevelsFlag) !== 0);

// Meili: (minor != true OR nsfwLevel IN [1, 2])
const meiliKeepsRow = (minor: boolean, nsfwLevel: number | null) =>
  !minor || (nsfwLevel != null && sfwBrowsingLevelsArray.includes(nsfwLevel as never));

// Client (useApplyHiddenPreferences): drop iff (minor && minorDisabled && !hasSafeBrowsingLevel)
const clientKeepsRow = (minor: boolean, nsfwLevel: number) =>
  !(minor && !hasSafeBrowsingLevel(nsfwLevel));

const dialects: Array<[string, (minor: boolean, nsfwLevel: number | null) => boolean]> = [
  ['sql', sqlKeepsRow],
  ['meili', meiliKeepsRow],
  ['client', (minor, level) => clientKeepsRow(minor, level ?? 0)],
];

describe('sfw-minor visibility gate', () => {
  describe.each(dialects)('%s predicate', (_name, keepsRow) => {
    it('shows SFW minor content (PG, PG-13)', () => {
      expect(keepsRow(true, NsfwLevel.PG)).toBe(true);
      expect(keepsRow(true, NsfwLevel.PG13)).toBe(true);
    });

    it('hides mature minor content (R, X, XXX)', () => {
      expect(keepsRow(true, NsfwLevel.R)).toBe(false);
      expect(keepsRow(true, NsfwLevel.X)).toBe(false);
      expect(keepsRow(true, NsfwLevel.XXX)).toBe(false);
    });

    it('hides minor content with NULL/0 nsfwLevel (fail closed)', () => {
      expect(keepsRow(true, 0)).toBe(false);
      expect(keepsRow(true, null)).toBe(false);
    });

    it('never touches non-minor content at any level', () => {
      for (const level of [
        0,
        NsfwLevel.PG,
        NsfwLevel.PG13,
        NsfwLevel.R,
        NsfwLevel.X,
        NsfwLevel.XXX,
      ])
        expect(keepsRow(false, level)).toBe(true);
    });
  });

  it('SFW flag is exactly {PG, PG-13} and cannot intersect any mature bit', () => {
    expect(sfwBrowsingLevelsArray).toEqual([NsfwLevel.PG, NsfwLevel.PG13]);
    for (const mature of [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX])
      expect(sfwBrowsingLevelsFlag & mature).toBe(0);
  });
});
