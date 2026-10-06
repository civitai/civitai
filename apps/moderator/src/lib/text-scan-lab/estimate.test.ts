import { describe, expect, it } from 'vitest';
import { DEFAULT_CASES_PER_SECOND, aboutTime, estimateSeconds } from './estimate';

describe('estimateSeconds', () => {
  it("uses the set's measured rate", () => {
    expect(estimateSeconds(421, 2)).toBe(211);
  });

  it(`falls back to ${DEFAULT_CASES_PER_SECOND} cases a second without a usable rate`, () => {
    expect(estimateSeconds(421, null)).toBe(36);
    expect(estimateSeconds(421, 0)).toBe(36);
  });
});

describe('aboutTime', () => {
  it('says seconds under a minute, to the nearest five, never below five', () => {
    expect(aboutTime(2)).toBe('About 5 s.');
    expect(aboutTime(16)).toBe('About 15 s.');
    expect(aboutTime(53)).toBe('About 55 s.');
  });

  it('rounds a minute or more to whole minutes', () => {
    expect(aboutTime(60)).toBe('About 1 min.');
    expect(aboutTime(211)).toBe('About 4 min.');
  });
});
