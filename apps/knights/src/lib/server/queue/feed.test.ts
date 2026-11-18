import { describe, expect, it } from 'vitest';
import {
  FEED,
  levelBucket,
  lowestTierPerItem,
  orderFeed,
  tieBreak,
  type FeedCandidate,
} from './feed';

const candidate = (id: number, o: Partial<FeedCandidate> = {}): FeedCandidate => ({
  id,
  tier: 1,
  priority: 2,
  createdAt: id,
  bucket: 'R',
  ...o,
});
const never = () => 0.99;
/** A small LCG, so a spread can be asserted deterministically. */
const seeded = (seed: number) => {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};
const always = () => 0;
const order = (
  candidates: FeedCandidate[],
  o: { recent?: FeedCandidate['bucket'][]; random?: () => number; limit?: number } = {}
) =>
  orderFeed(candidates, {
    playerId: 1,
    recent: o.recent ?? [],
    random: o.random ?? never,
    limit: o.limit ?? 10,
  }).map((c) => c.id);

describe('levelBucket', () => {
  it('maps a level flag to its bucket and anything else to null', () => {
    expect([1, 2, 4, 8, 16].map(levelBucket)).toEqual(['PG', 'PG-13', 'R', 'X', 'XXX']);
    expect([0, 32, 99].map(levelBucket)).toEqual([null, null, null]);
  });
});

describe('tieBreak', () => {
  it('is stable for a player and item, and differs between players', () => {
    expect(tieBreak(1, 5)).toBe(tieBreak(1, 5));
    const firsts = new Set(
      [1, 2, 3, 4, 5, 6].map(
        (p) =>
          [...Array(12).keys()].map((i) => i + 1).sort((a, b) => tieBreak(p, a) - tieBreak(p, b))[0]
      )
    );
    expect(firsts.size).toBeGreaterThan(1);
  });
});

describe('orderFeed', () => {
  it('takes the first candidate whose bucket is not among the recent ones', () => {
    const window = [candidate(1), candidate(2), candidate(3, { bucket: 'X' })];
    expect(order(window, { recent: ['R', 'R', 'R'], limit: 1 })).toEqual([3]);
  });

  it('falls back to the first candidate when every bucket was recent', () => {
    const window = [candidate(1), candidate(2)];
    const own = [1, 2].sort((a, b) => tieBreak(1, a) - tieBreak(1, b))[0];
    expect(order(window, { recent: ['R'], limit: 1 })).toEqual([own]);
  });

  it('rotates buckets through a stretch too', () => {
    const window = [
      candidate(1),
      candidate(2),
      candidate(3, { bucket: 'X' }),
      candidate(4, { bucket: 'X' }),
    ];
    const served = order(window, { recent: ['PG'] });
    const buckets = served.map((id) => window.find((c) => c.id === id)?.bucket);
    expect(buckets[0]).not.toBe(buckets[1]);
    expect(served).toHaveLength(4);
  });

  it('keeps priority classes in order within a bucket', () => {
    const window = [candidate(1, { priority: 1 }), candidate(2, { priority: 3 })];
    expect(order(window, { limit: 2 })).toEqual([1, 2]);
  });

  it('serves the escalated tier ahead of normal priority', () => {
    const window = [candidate(1, { tier: 0, priority: 3 }), candidate(2, { priority: 1 })];
    expect(order(window, { limit: 1 })).toEqual([1]);
  });

  it('breaks ties between equal candidates per player, deterministically', () => {
    const window = [...Array(12).keys()].map((i) => candidate(i + 1));
    const firstFor = (playerId: number) =>
      orderFeed(window, { playerId, recent: [], random: never, limit: 1 })[0].id;
    const firsts = [1, 2, 3, 4, 5, 6].map(firstFor);
    expect(new Set(firsts).size).toBeGreaterThan(1);
    expect([1, 2, 3, 4, 5, 6].map(firstFor)).toEqual(firsts);
  });

  it('takes the oldest of the chosen bucket when the starvation draw lands, even against priority', () => {
    const window = [
      candidate(1, { createdAt: 50, priority: 1 }),
      candidate(2, { createdAt: 10, priority: 3 }),
      candidate(3, { createdAt: 1, bucket: 'X' }),
    ];
    expect(order(window, { recent: ['X'], random: always, limit: 1 })).toEqual([2]);
    expect(order(window, { recent: ['X'], random: never, limit: 1 })).toEqual([1]);
  });

  it('picks buckets with equal probability, whatever their size or priority', () => {
    // PG holds most of the supply and the urgent class, as owner ratings do; the small buckets must still get their share.
    const sizes = { PG: 30, X: 3, XXX: 3 } as const;
    const window = Object.entries(sizes).flatMap(([bucket, size], b) =>
      [...Array(size).keys()].map((i) =>
        candidate(b * 100 + i + 1, {
          bucket: bucket as keyof typeof sizes,
          priority: bucket === 'PG' ? 1 : 2,
          createdAt: i,
        })
      )
    );
    const bucketOf = (id: number) => window.find((c) => c.id === id)?.bucket;
    for (const seed of [1, 7, 42]) {
      // While every bucket has supply (9 picks), each takes about a third, not its 30:3:3 share of the window.
      const served = order(window, { random: seeded(seed), limit: 9 });
      for (const bucket of Object.keys(sizes)) {
        const count = served.filter((id) => bucketOf(id) === bucket).length;
        expect(count).toBeGreaterThanOrEqual(2);
        expect(count).toBeLessThanOrEqual(4);
      }
      expect(order(window, { random: seeded(seed), limit: 9 })).toEqual(served);
    }
  });

  it('never draws a bucket that has no candidates', () => {
    const window = [candidate(1, { bucket: 'PG' }), candidate(2, { bucket: 'XXX' })];
    // One draw value per slot of the five-bucket list: an empty bucket in the draw would be hit by the middle ones.
    for (const draw of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const served = order(window, { random: () => draw, limit: 1 });
      expect(served).toHaveLength(1);
      expect([1, 2]).toContain(served[0]);
    }
  });

  it('drops a bucket once it is empty and keeps serving the others', () => {
    const window = [
      candidate(1, { bucket: 'PG' }),
      ...[2, 3, 4, 5, 6].map((id) => candidate(id, { bucket: 'X' })),
    ];
    const served = order(window, { random: seeded(3), limit: 10 });
    expect([...served].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('avoids a recent no-bucket item like any other bucket', () => {
    const window = [candidate(1, { bucket: null }), candidate(2, { bucket: 'R' })];
    expect(order(window, { recent: [null], limit: 1 })).toEqual([2]);
  });

  it("serves a bucket's escalated items before its other items", () => {
    const buckets = ['PG', 'R', 'XXX'] as const;
    const window = buckets.flatMap((bucket, b) => [
      candidate(b * 10 + 1, { bucket, tier: 0, priority: 3 }),
      candidate(b * 10 + 2, { bucket, priority: 1 }),
      candidate(b * 10 + 3, { bucket, priority: 1 }),
    ]);
    const served = order(window, { random: seeded(11), limit: 9 });
    for (let b = 0; b < buckets.length; b++) {
      const mine = served.filter((id) => Math.floor(id / 10) === b);
      expect(mine[0]).toBe(b * 10 + 1);
    }
  });

  it('draws the starvation path about once in ten serves', () => {
    expect(FEED.starvationShare).toBeCloseTo(0.1);
  });
});

describe('lowestTierPerItem', () => {
  it('keeps the escalated copy of an item even when the normal copy comes first', () => {
    const rows = [
      { id: 7, tier: 1 },
      { id: 8, tier: 1 },
      { id: 7, tier: 0 },
    ];
    expect(lowestTierPerItem(rows)).toEqual([
      { id: 7, tier: 0 },
      { id: 8, tier: 1 },
    ]);
    expect(lowestTierPerItem([...rows].reverse()).find((r) => r.id === 7)?.tier).toBe(0);
  });
});
