import { describe, expect, it, vi } from 'vitest';

import {
  rollupImageScoreDeltas,
  foldImageDeltasOntoStored,
  getImageScore,
  SELF_EXCLUSION_SINCE_KEY,
} from '~/server/jobs/update-user-score';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mult = { reactions: 10, comments: 20 };

describe('rollupImageScoreDeltas', () => {
  it('rolls per-image deltas up per owner with multipliers', () => {
    const deltas = [
      { imageId: 1, userId: 9, dReactions: 3, dComments: 1 }, // 3*10 + 1*20 = 50
      { imageId: 2, userId: 9, dReactions: 1, dComments: 0 }, // 1*10        = 10
    ];
    const owners = new Map([
      [1, 100],
      [2, 100],
    ]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[100, 60]]));
  });

  it('handles negative deltas (un-like / removed comment)', () => {
    const deltas = [{ imageId: 1, userId: 9, dReactions: -2, dComments: -1 }]; // -2*10 + -1*20 = -40
    const owners = new Map([[1, 7]]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[7, -40]]));
  });

  it('skips images with no owner (deleted / null userId)', () => {
    const deltas = [
      { imageId: 1, userId: 9, dReactions: 5, dComments: 0 },
      { imageId: 2, userId: 9, dReactions: 9, dComments: 9 }, // no owner entry -> skipped
    ];
    const owners = new Map([[1, 100]]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[100, 50]]));
  });

  it("leaves out the owner's own reactions and comments, in both directions", () => {
    const deltas = [
      { imageId: 1, userId: 9, dReactions: 2, dComments: 0 }, // 2*10 = 20
      { imageId: 1, userId: 100, dReactions: 5, dComments: 3 },
      { imageId: 2, userId: 100, dReactions: -1, dComments: -1 },
    ];
    const owners = new Map([
      [1, 100],
      [2, 100],
    ]);
    expect(rollupImageScoreDeltas(deltas, owners, mult)).toEqual(new Map([[100, 20]]));
  });

  it('looks the owner up by a numeric image id, as ClickHouse may send strings', () => {
    const deltas = [{ imageId: '1' as unknown as number, userId: 9, dReactions: 1, dComments: 0 }];
    expect(rollupImageScoreDeltas(deltas, new Map([[1, 100]]), mult)).toEqual(new Map([[100, 10]]));
  });

  it('compares the actor to the owner as numbers, as ClickHouse may send strings', () => {
    const deltas = [
      { imageId: 1, userId: '100' as unknown as number, dReactions: 5, dComments: 0 },
      { imageId: 1, userId: '9' as unknown as number, dReactions: 1, dComments: 0 },
    ];
    expect(rollupImageScoreDeltas(deltas, new Map([[1, 100]]), mult)).toEqual(new Map([[100, 10]]));
  });

  it('coerces string-typed clickhouse numbers', () => {
    const deltas = [
      {
        imageId: 1,
        userId: 9,
        dReactions: '2' as unknown as number,
        dComments: '3' as unknown as number,
      },
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

  it('floors at 0 when a negative delta exceeds the stored score', () => {
    const delta = new Map([
      [1, -50],
      [2, -10],
    ]);
    const stored = new Map([
      [1, 10],
      [2, 30],
    ]);
    expect(foldImageDeltasOntoStored(delta, stored)).toEqual(
      new Map([
        [1, 0],
        [2, 20],
      ])
    );
  });
});

function fakeQuery<T>(rows: T[]) {
  return { result: async () => rows, cancel: async () => undefined };
}

describe('getImageScore (incremental wiring)', () => {
  it('folds CH deltas onto stored scores and calls setScore with absolute values', async () => {
    const setCalls: Array<[number, string, number]> = [];
    const chSql: string[] = [];
    let pgCall = 0;
    const keyValueWrites: [string, unknown[] | undefined][] = [];
    const ctx = {
      ch: {
        $query: async (strings: TemplateStringsArray) => {
          chSql.push(strings.join('?'));
          return [
            { imageId: 10, userId: 9, dReactions: 3, dComments: 0 }, // owner 100
            { imageId: 11, userId: 9, dReactions: 0, dComments: 1 }, // owner 100
            { imageId: 11, userId: 100, dReactions: 4, dComments: 2 }, // owner 100, on their own image
            { imageId: 12, userId: 9, dReactions: 5, dComments: 0 }, // owner 200
          ];
        },
      },
      pg: {
        cancellableQuery: async (sql: string, params?: unknown[]) => {
          if (sql.includes('"KeyValue"')) {
            keyValueWrites.push([sql, params]);
            return fakeQuery([]);
          }
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

    expect(chSql[0]).toMatch(/GROUP BY entityId, userId\s/);
    // owner 100: (3*10 + 1*20) = 50 onto stored 1000 -> 1050; their own 4 + 2 are left out
    // owner 200: (5*10)        = 50 onto stored 0    -> 50
    const map = new Map(setCalls.map(([id, , score]) => [id, score]));
    expect(setCalls.every(([, cat]) => cat === 'images')).toBe(true);
    expect(map.get(100)).toBe(1050);
    expect(map.get(200)).toBe(50);
    // Records, once, the checkpoint the first excluding run read from.
    expect(keyValueWrites).toHaveLength(1);
    expect(keyValueWrites[0][0]).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect(keyValueWrites[0][1]).toEqual([SELF_EXCLUSION_SINCE_KEY, 0]);
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
