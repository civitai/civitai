import { describe, expect, it } from 'vitest';
import type { AutoFeatureCandidate } from '~/server/services/auto-feature-images.service';
import { selectAutoFeaturePicks } from '~/server/services/auto-feature-images.service';
import type { AutoFeatureSchema } from '~/server/schema/home-block.schema';

const NOW = new Date('2026-08-12T12:00:00Z');

const config = (overrides: Partial<AutoFeatureSchema> = {}): AutoFeatureSchema => ({
  collectionId: 107,
  dryRun: false,
  perRun: 5,
  intervalHours: 6,
  windowDays: 7,
  recencyOffsetHours: 12,
  decayExponent: 0.8,
  maxPerCreatorPerRun: 1,
  maxPerCreatorInWindow: 2,
  maxPerCollectionInWindow: undefined,
  minReactions: 0,
  strategy: 'round-robin',
  ...overrides,
});

let nextImageId = 1;
const candidate = (
  overrides: Partial<AutoFeatureCandidate> & Pick<AutoFeatureCandidate, 'collectionId'>
): AutoFeatureCandidate => ({
  imageId: nextImageId++,
  userId: 900 + nextImageId,
  curatedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
  reactions: 100,
  ...overrides,
});

const select = (
  candidates: AutoFeatureCandidate[],
  cfg = config(),
  opts: {
    creatorCounts?: Map<number, number>;
    collectionCounts?: Map<number, number>;
    rotationOffset?: number;
  } = {}
) =>
  selectAutoFeaturePicks({
    candidates,
    config: cfg,
    now: NOW,
    creatorCounts: opts.creatorCounts ?? new Map(),
    collectionCounts: opts.collectionCounts ?? new Map(),
    rotationOffset: opts.rotationOffset ?? 0,
  });

describe('selectAutoFeaturePicks', () => {
  it('spreads picks across collections instead of letting the busiest one dominate', () => {
    // 40 candidates from the busy collection, 2 each from four others, and the busy one's
    // items also score highest — the exact shape that made global ranking unusable.
    const candidates = [
      ...Array.from({ length: 40 }, () => candidate({ collectionId: 1, reactions: 2000 })),
      ...[2, 3, 4, 5].flatMap((collectionId) => [
        candidate({ collectionId, reactions: 50 }),
        candidate({ collectionId, reactions: 40 }),
      ]),
    ];

    const picks = select(candidates);

    expect(picks).toHaveLength(5);
    expect(new Set(picks.map((p) => p.collectionId)).size).toBe(5);
    expect(picks.filter((p) => p.collectionId === 1)).toHaveLength(1);
  });

  it('takes the highest scoring item within each collection', () => {
    const best = candidate({ collectionId: 1, reactions: 500 });
    const candidates = [
      candidate({ collectionId: 1, reactions: 10 }),
      best,
      candidate({ collectionId: 1, reactions: 100 }),
    ];

    const picks = select(candidates, config({ perRun: 1 }));

    expect(picks.map((p) => p.imageId)).toEqual([best.imageId]);
  });

  it('prefers a fresher item over an older one with the same reactions', () => {
    const fresh = candidate({
      collectionId: 1,
      reactions: 100,
      curatedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    const stale = candidate({
      collectionId: 1,
      reactions: 100,
      curatedAt: new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1000),
    });

    const picks = select([stale, fresh], config({ perRun: 1 }));

    expect(picks[0].imageId).toBe(fresh.imageId);
  });

  it('takes at most one item per creator in a run, even across collections', () => {
    const hog = 42;
    const candidates = [
      candidate({ collectionId: 1, userId: hog, reactions: 900 }),
      candidate({ collectionId: 2, userId: hog, reactions: 800 }),
      candidate({ collectionId: 3, userId: hog, reactions: 700 }),
      candidate({ collectionId: 4, userId: 7, reactions: 10 }),
    ];

    const picks = select(candidates);

    expect(picks.filter((p) => p.userId === hog)).toHaveLength(1);
    expect(picks).toHaveLength(2);
  });

  it('honors a creator who is already at the window cap', () => {
    const capped = 42;
    const candidates = [
      candidate({ collectionId: 1, userId: capped, reactions: 900 }),
      candidate({ collectionId: 2, userId: 7, reactions: 10 }),
    ];

    const picks = select(candidates, config(), { creatorCounts: new Map([[capped, 2]]) });

    expect(picks.map((p) => p.userId)).toEqual([7]);
  });

  it('honors a per-collection window cap when one is configured', () => {
    const candidates = [
      candidate({ collectionId: 1, reactions: 900 }),
      candidate({ collectionId: 2, reactions: 10 }),
    ];

    const picks = select(candidates, config({ maxPerCollectionInWindow: 3 }), {
      collectionCounts: new Map([[1, 3]]),
    });

    expect(picks.map((p) => p.collectionId)).toEqual([2]);
  });

  it('drops candidates below the reaction floor', () => {
    const candidates = [
      candidate({ collectionId: 1, reactions: 5 }),
      candidate({ collectionId: 2, reactions: 60 }),
    ];

    const picks = select(candidates, config({ minReactions: 50 }));

    expect(picks.map((p) => p.reactions)).toEqual([60]);
  });

  it('advances which collection is served first as the rotation offset moves', () => {
    const candidates = [1, 2, 3, 4].map((collectionId) => candidate({ collectionId }));

    const first = select(candidates, config({ perRun: 1 }), { rotationOffset: 0 });
    const second = select(candidates, config({ perRun: 1 }), { rotationOffset: 1 });

    expect(first[0].collectionId).toBe(1);
    expect(second[0].collectionId).toBe(2);
  });

  it('keeps filling from other collections when one runs dry', () => {
    const candidates = [
      candidate({ collectionId: 1 }),
      ...Array.from({ length: 8 }, () => candidate({ collectionId: 2 })),
    ];

    const picks = select(candidates);

    expect(picks).toHaveLength(5);
    expect(picks.filter((p) => p.collectionId === 2)).toHaveLength(4);
  });

  it('terminates and returns what it has when every candidate is capped out', () => {
    const hog = 42;
    const candidates = Array.from({ length: 30 }, (_, i) =>
      candidate({ collectionId: (i % 5) + 1, userId: hog })
    );

    const picks = select(candidates);

    expect(picks).toHaveLength(1);
  });

  it('returns nothing when there are no candidates', () => {
    expect(select([])).toEqual([]);
  });

  it('lets one collection dominate under the global strategy', () => {
    // The measured behaviour the round-robin default exists to avoid. Pinned so that flipping
    // `strategy` back is a deliberate choice with a known consequence, not a surprise.
    const candidates = [
      ...Array.from({ length: 10 }, () => candidate({ collectionId: 1, reactions: 2000 })),
      candidate({ collectionId: 2, reactions: 10 }),
    ];

    const picks = select(candidates, config({ strategy: 'global' }));

    expect(picks).toHaveLength(5);
    expect(picks.every((p) => p.collectionId === 1)).toBe(true);
  });
});
