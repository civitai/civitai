import { describe, expect, it } from 'vitest';
import { diffCounts } from './source-ratchet.harness';

// Every ratchet in this directory decides GROWN and SHRUNK through diffCounts, and against the live
// repo both buckets are empty, so the comparison itself is pinned here on synthetic counts.
describe('diffCounts', () => {
  it('reports a new file and a raised count as grown, a lowered or removed file as shrunk', () => {
    const baseline = { 'a.ts': 3, 'b.ts': 5, 'c.ts': 7, 'd.ts': 11 };
    const current = { 'a.ts': 3, 'b.ts': 6, 'c.ts': 2, 'e.ts': 4 };
    expect(diffCounts(current, baseline)).toEqual({
      grown: ['b.ts: baseline 5, now 6', 'e.ts: baseline 0, now 4'],
      shrunk: ['c.ts: baseline 7, now 2', 'd.ts: baseline 11, now 0'],
    });
  });

  it('reports nothing when the counts match the baseline exactly', () => {
    expect(diffCounts({ 'a.ts': 9, 'b.ts': 13 }, { 'b.ts': 13, 'a.ts': 9 })).toEqual({
      grown: [],
      shrunk: [],
    });
  });
});
