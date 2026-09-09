import { describe, expect, it } from 'vitest';
import {
  buildCountryBreakdown,
  countryName,
  emptyWindows,
  mergeReachChunks,
  presentReach,
  redactReach,
  MIN_FOLLOWERS_FOR_REACH,
  MIN_FOLLOWERS_PER_COUNTRY,
  MAX_COUNTRY_SLICES,
  type ReachRow,
} from '../../analytics/follower-reach';

const row = (country: string, followers: number, a30 = 0, a60 = 0, a100 = 0): ReachRow => ({
  country,
  followers,
  active: { 30: a30, 60: a60, 100: a100 },
});

const totalFollowers = (r: ReturnType<typeof mergeReachChunks>) =>
  r.countries.reduce((sum, c) => sum + c.followers, 0);

describe('mergeReachChunks', () => {
  it('sums a country and a window across chunks rather than taking one', () => {
    const merged = mergeReachChunks(
      [[row('US', 10, 6, 8, 9), row('DE', 4, 1, 2, 3)], [row('US', 5, 3, 4, 5)]],
      19
    );

    expect(merged.countries).toContainEqual({ code: 'US', followers: 15 });
    expect(merged.countries).toContainEqual({ code: 'DE', followers: 4 });
    expect(merged.active).toEqual({ 30: 10, 60: 14, 100: 17 });
  });

  it('folds followers with no rollup row into the unknown bucket', () => {
    const merged = mergeReachChunks([[row('US', 10, 10, 10, 10)]], 25);

    expect(merged.countries).toContainEqual({ code: '', followers: 15 });
    expect(merged.active[30]).toBe(10);
  });

  it('keeps the country slices summing to the follower count the rest of the page shows', () => {
    for (const [chunks, followers] of [
      [[[row('US', 3), row('', 2)]], 5],
      [[[row('US', 3)]], 40],
      [[], 0],
      [[[]], 12],
    ] as [ReachRow[][], number][]) {
      expect(totalFollowers(mergeReachChunks(chunks, followers))).toBe(followers);
    }
  });

  it('does not invent an unknown bucket when every follower is accounted for', () => {
    const merged = mergeReachChunks([[row('US', 7), row('JP', 3)]], 10);
    expect(merged.countries.map((c) => c.code)).not.toContain('');
  });
});

describe('buildCountryBreakdown', () => {
  it('folds countries under the floor into Other and keeps unknown separate', () => {
    const breakdown = buildCountryBreakdown([
      { code: 'US', followers: 40 },
      { code: 'DE', followers: 12 },
      { code: 'PT', followers: MIN_FOLLOWERS_PER_COUNTRY - 1 },
      { code: 'NZ', followers: 1 },
      { code: '', followers: 9 },
    ]);

    expect(breakdown.slices).toEqual([
      { code: 'US', followers: 40 },
      { code: 'DE', followers: 12 },
    ]);
    expect(breakdown.other).toBe(MIN_FOLLOWERS_PER_COUNTRY - 1 + 1);
    expect(breakdown.unknown).toBe(9);
  });

  it('lists at most the palette-sized number of countries and folds the rest', () => {
    // Past MAX_COUNTRY_SLICES, `chartColor` wraps and a slice reuses an earlier arc's color.
    const countries = Array.from({ length: MAX_COUNTRY_SLICES + 3 }, (_, i) => ({
      code: `C${i}`,
      followers: 100 - i,
    }));
    const breakdown = buildCountryBreakdown(countries);

    expect(breakdown.slices).toHaveLength(MAX_COUNTRY_SLICES);
    expect(breakdown.slices.map((s) => s.code)).toEqual(['C0', 'C1', 'C2', 'C3', 'C4']);
    expect(breakdown.other).toBe(
      countries.slice(MAX_COUNTRY_SLICES).reduce((s, c) => s + c.followers, 0)
    );
  });

  it('keeps a country sitting exactly on the floor', () => {
    const breakdown = buildCountryBreakdown([{ code: 'FR', followers: MIN_FOLLOWERS_PER_COUNTRY }]);
    expect(breakdown.slices).toEqual([{ code: 'FR', followers: MIN_FOLLOWERS_PER_COUNTRY }]);
    expect(breakdown.other).toBe(0);
  });

  it('never counts a follower twice across slices, other and unknown', () => {
    const countries = [
      { code: 'US', followers: 40 },
      { code: 'NZ', followers: 1 },
      { code: '', followers: 9 },
    ];
    const b = buildCountryBreakdown(countries);
    const shown = b.slices.reduce((sum, s) => sum + s.followers, 0) + b.other + b.unknown;
    expect(shown).toBe(countries.reduce((sum, c) => sum + c.followers, 0));
  });
});

describe('redactReach', () => {
  // The disclosure rule this protects: a country holding a single follower must not survive into the page
  // payload, because SvelteKit serialises the whole load return into the HTML and into __data.json. Moving
  // the redaction back into the component would leave this failing.
  it('drops every below-floor country from the value that leaves the server', () => {
    const redacted = redactReach(
      mergeReachChunks([[row('US', 90), row('NO', 1), row('BR', 1)]], 92)
    );

    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain('NO');
    expect(serialised).not.toContain('BR');
    expect(redacted.countries.other).toBe(2);
    expect(redacted.countries.slices).toEqual([{ code: 'US', followers: 90 }]);
  });
});

describe('presentReach', () => {
  it('withholds the reach data entirely below the follower floor', () => {
    const under = redactReach(mergeReachChunks([[row('US', 3)]], MIN_FOLLOWERS_FOR_REACH - 1));
    const result = presentReach(under);

    expect(result.status).toBe('suppressed');
    // Not merely a flag beside the data — there must be nothing left to read.
    expect(JSON.stringify(result)).not.toContain('US');
  });

  it('passes a creator sitting exactly on the floor through', () => {
    const at = redactReach(
      mergeReachChunks([[row('US', MIN_FOLLOWERS_FOR_REACH, 10, 10, 10)]], MIN_FOLLOWERS_FOR_REACH)
    );
    const result = presentReach(at);

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.reach.active[30]).toBe(10);
  });
});

describe('emptyWindows', () => {
  it('carries a counter for every declared window', () => {
    // A fourth REACH_WINDOWS entry whose counter is missing type-checks fine and renders as a confident 0.0%.
    expect(
      Object.keys(emptyWindows())
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual([30, 60, 100]);
  });
});

describe('countryName', () => {
  it('resolves an ISO region and passes through what is not one', () => {
    expect(countryName('US')).toBe('United States');
    expect(countryName('')).toBe('Unknown');
    // Cloudflare emits 'T1' for Tor and 'XX' when it cannot place the request; neither is an ISO region,
    // and Intl.DisplayNames#of throws on the malformed one rather than returning undefined.
    expect(countryName('T1')).toBe('T1');
  });
});
