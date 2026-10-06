import { describe, expect, it } from 'vitest';
import { DEFAULT_CASES_PER_SECOND, aboutMinutes, estimateSeconds } from './estimate';

describe('estimateSeconds', () => {
  it("uses the set's measured rate", () => {
    expect(estimateSeconds(421, 2)).toBe(211);
  });

  it(`falls back to ${DEFAULT_CASES_PER_SECOND} cases a second without a usable rate`, () => {
    expect(estimateSeconds(421, null)).toBe(53);
    expect(estimateSeconds(421, 0)).toBe(53);
  });
});

describe('aboutMinutes', () => {
  it('rounds to whole minutes, never below one', () => {
    expect(aboutMinutes(53)).toBe('About 1 min.');
    expect(aboutMinutes(10)).toBe('About 1 min.');
    expect(aboutMinutes(211)).toBe('About 4 min.');
  });
});
