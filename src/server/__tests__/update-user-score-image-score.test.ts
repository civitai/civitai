import { describe, expect, it } from 'vitest';
import {
  rollupImageScoreDeltas,
  foldImageDeltasOntoStored,
  getImageScore,
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

function fakeQuery<T>(rows: T[]) {
  return { result: async () => rows, cancel: async () => undefined };
}

describe('getImageScore (incremental wiring)', () => {
  it('folds CH deltas onto stored scores and calls setScore with absolute values', async () => {
    const setCalls: Array<[number, string, number]> = [];
    let pgCall = 0;
    const ctx = {
      ch: {
        $query: async () => [
          { imageId: 10, dReactions: 3, dComments: 0 }, // owner 100
          { imageId: 11, dReactions: 0, dComments: 1 }, // owner 100
          { imageId: 12, dReactions: 5, dComments: 0 }, // owner 200
        ],
      },
      pg: {
        cancellableQuery: async () => {
          pgCall += 1;
          if (pgCall === 1)
            return fakeQuery([
              { id: 10, userId: 100 },
              { id: 11, userId: 100 },
              { id: 12, userId: 200 },
            ]);
          return fakeQuery([
            { id: 100, images: '1000' },
            { id: 200, images: null },
          ]);
        },
      },
      jobContext: { on: () => undefined },
      scoreMultipliers: { images: { reactions: 10, comments: 20 } },
      lastUpdate: new Date(0),
      setScore: (id: number, category: string, score: number) =>
        setCalls.push([id, category, score]),
    } as unknown as Parameters<typeof getImageScore>[0];

    await getImageScore(ctx);

    // owner 100: (3*10 + 1*20) = 50 onto stored 1000 -> 1050
    // owner 200: (5*10)        = 50 onto stored 0    -> 50
    const map = new Map(setCalls.map(([id, , score]) => [id, score]));
    expect(setCalls.every(([, cat]) => cat === 'images')).toBe(true);
    expect(map.get(100)).toBe(1050);
    expect(map.get(200)).toBe(50);
  });

  it('no-ops when there are no engagement deltas', async () => {
    const setCalls: unknown[] = [];
    const ctx = {
      ch: { $query: async () => [] },
      pg: { cancellableQuery: async () => fakeQuery([]) },
      jobContext: { on: () => undefined },
      scoreMultipliers: { images: { reactions: 10, comments: 20 } },
      lastUpdate: new Date(0),
      setScore: () => setCalls.push(1),
    } as unknown as Parameters<typeof getImageScore>[0];

    await getImageScore(ctx);
    expect(setCalls).toHaveLength(0);
  });
});
