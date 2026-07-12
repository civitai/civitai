import { describe, expect, it } from 'vitest';
import {
  rollupImageScoreDeltas,
  foldImageDeltasOntoStored,
} from '~/server/jobs/update-user-score';

const mult = { reactions: 10, comments: 20 };

describe('rollupImageScoreDeltas', () => {
  it('rolls per-image deltas up per owner with multipliers', () => {
    const deltas = [
      { imageId: 1, dReactions: 3, dComments: 1 }, // 3*10 + 1*20 = 50
      { imageId: 2, dReactions: 1, dComments: 0 }, // 1*10        = 10
    ];
    const owners = new Map([
      [1, 100],
      [2, 100],
    ]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[100, 60]]));
  });

  it('handles negative deltas (un-like / removed comment)', () => {
    const deltas = [{ imageId: 1, dReactions: -2, dComments: -1 }]; // -2*10 + -1*20 = -40
    const owners = new Map([[1, 7]]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[7, -40]]));
  });

  it('skips images with no owner (deleted / null userId)', () => {
    const deltas = [
      { imageId: 1, dReactions: 5, dComments: 0 },
      { imageId: 2, dReactions: 9, dComments: 9 }, // no owner entry -> skipped
    ];
    const owners = new Map([[1, 100]]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[100, 50]]));
  });

  it('coerces string-typed clickhouse numbers', () => {
    const deltas = [
      { imageId: 1, dReactions: '2' as unknown as number, dComments: '3' as unknown as number },
    ];
    const owners = new Map([[1, 1]]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[1, 2 * 10 + 3 * 20]]));
  });
});

describe('foldImageDeltasOntoStored', () => {
  it('adds delta to stored score', () => {
    const delta = new Map([
      [1, 50],
      [2, -10],
    ]);
    const stored = new Map([
      [1, 1000],
      [2, 30],
    ]);
    expect(foldImageDeltasOntoStored(delta, stored)).toEqual(
      new Map([
        [1, 1050],
        [2, 20],
      ])
    );
  });

  it('treats a missing stored score as 0 (new owner)', () => {
    const delta = new Map([[5, 40]]);
    const stored = new Map<number, number>();
    expect(foldImageDeltasOntoStored(delta, stored)).toEqual(new Map([[5, 40]]));
  });
});
