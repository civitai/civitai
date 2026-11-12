import { describe, expect, it } from 'vitest';
import { browsingLevels, NsfwLevel, sfwBrowsingLevelsFlag } from '../browsing-levels';
import {
  isMinorContentRestricted,
  isMinorRestrictedLevel,
  MINOR_CONTENT_MAX_LEVEL,
  minorContentBrowsingLevelsFlag,
} from '../minor-content-gate';

const { PG, PG13, R, X, XXX, Blocked } = NsfwLevel;

// The rule's values. An unrated (0) rating is restricted for minor content, like a missing one.
const LEVELS: [string, number | null | undefined, boolean][] = [
  ['unknown (null)', null, true],
  ['unknown (undefined)', undefined, true],
  ['unrated', 0, true],
  ['PG', PG, false],
  ['PG-13', PG13, false],
  ['PG and PG-13', PG | PG13, false],
  ['R', R, true],
  ['X', X, true],
  ['XXX', XXX, true],
  ['Blocked', Blocked, true],
  ['PG with R', PG | R, true],
];

describe('minor content rule', () => {
  it.each(LEVELS)('a minor at %s is restricted: %s', (_, nsfwLevel, restricted) => {
    expect(isMinorContentRestricted({ minor: true, nsfwLevel })).toBe(restricted);
    expect(isMinorRestrictedLevel(nsfwLevel)).toBe(restricted);
  });

  it.each(LEVELS)('content with no minor at %s is never restricted', (_, nsfwLevel) => {
    expect(isMinorContentRestricted({ minor: false, nsfwLevel })).toBe(false);
  });

  it('the ceiling and the flag allow exactly the ratings the rule does not restrict', () => {
    for (const level of browsingLevels) {
      const allowed = !isMinorRestrictedLevel(level);
      expect(level <= MINOR_CONTENT_MAX_LEVEL, `level ${level}`).toBe(allowed);
      expect((minorContentBrowsingLevelsFlag & level) !== 0, `level ${level}`).toBe(allowed);
    }
  });

  it('the numeric ceiling covers rated levels only: an unrated rating passes it but not the rule', () => {
    expect(0 <= MINOR_CONTENT_MAX_LEVEL).toBe(true);
    expect(isMinorRestrictedLevel(0)).toBe(true);
    expect(minorContentBrowsingLevelsFlag & 0).toBe(0);
  });

  it('holds minor content to the safe-for-work levels, as before the gates shared the rule', () => {
    expect(minorContentBrowsingLevelsFlag).toBe(sfwBrowsingLevelsFlag);
    expect(MINOR_CONTENT_MAX_LEVEL).toBe(PG13);
  });
});
