import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  ecosystemLift,
  matureAllowed,
  resolveEcosystems,
  TAG_SCORE_PARAMS,
} from '~/server/services/resource-intent-tags/score';

describe('matureAllowed', () => {
  it('lets a request match explicit tags only when its level includes R, X or XXX', () => {
    expect(matureAllowed(NsfwLevel.PG | NsfwLevel.PG13)).toBe(false);
    expect(matureAllowed(NsfwLevel.R)).toBe(true);
    expect(matureAllowed(NsfwLevel.PG | NsfwLevel.X)).toBe(true);
    expect(matureAllowed(NsfwLevel.XXX)).toBe(true);
    // The prototype tested "any bit but PG/PG-13", which also admits Blocked alone; the served rule
    // names the mature levels, so Blocked by itself does not open the explicit tags.
    expect(matureAllowed(NsfwLevel.Blocked)).toBe(false);
    // Not a clamped level: -1 has every bit set, and must not read as mature.
    expect(matureAllowed(-1)).toBe(false);
  });
});

describe('ecosystemLift', () => {
  it('equals the prototype rule (Dirichlet m = 50) on its own training counts', () => {
    // Expected values came from the prototype's eco_options over synthetic rows: 100 observations on
    // Small, 800 on Big; tag x seen 3 times, all on Small; tag y 6 times, 1 on Small and 5 on Big.
    const m = TAG_SCORE_PARAMS.liftPrior;
    expect(ecosystemLift(3, 3, 100, 900, m)).toBeCloseTo(1.4528301886792452, 14);
    expect(ecosystemLift(0, 3, 800, 900, m)).toBeCloseTo(0.9433962264150944, 14);
    expect(ecosystemLift(1, 6, 100, 900, m)).toBeCloseTo(1.0535714285714286, 14);
    expect(ecosystemLift(5, 6, 800, 900, m)).toBeCloseTo(0.9933035714285714, 14);
  });
});

describe('resolveEcosystems', () => {
  it('ranks only ecosystems with >= 100 users, and equal scores keep users-descending then name order', () => {
    const ecosystems = [
      { name: 'Zed', users: 150, observations: 10 },
      { name: 'Ace', users: 150, observations: 10 },
      { name: 'Low', users: 99, observations: 10 },
      { name: 'Mid', users: 300, observations: 10 },
    ];
    // Tag 0 has no counts, so no ecosystem gets a vote and every score is 0.
    const ranked = resolveEcosystems(
      { ecosystems, tagEcosystemCounts: new Map() },
      new Map([[0, 1]]),
      5
    );
    expect(ranked.map((x) => ecosystems[x.id].name)).toEqual(['Mid', 'Ace', 'Zed']);
  });
});
