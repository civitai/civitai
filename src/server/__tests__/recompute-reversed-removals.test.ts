import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storedScores: vi.fn(),
  applyUserScoreUpdates: vi.fn(),
  removalPenaltyWeightsByOwner: vi.fn(),
  getOwnersWithReversalsSince: vi.fn(),
  getOwnersWithRemovals: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: {},
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: async (_sql: string, [ids]: [number[]]) => ({
      result: async () => mocks.storedScores(ids),
      cancel: async () => undefined,
    }),
  },
  pgDbReadLong: {},
  pgDbWrite: {},
}));
vi.mock('~/server/jobs/update-user-score', async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateUserScore>()),
  applyUserScoreUpdates: mocks.applyUserScoreUpdates,
  getScoreMultipliers: async () => ({ reportsAgainst: -1000 }),
}));
vi.mock('~/server/services/creator-removals.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorRemovals>()),
  removalPenaltyWeightsByOwner: mocks.removalPenaltyWeightsByOwner,
  getOwnersWithReversalsSince: mocks.getOwnersWithReversalsSince,
  getOwnersWithRemovals: mocks.getOwnersWithRemovals,
}));

import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as UpdateUserScore from '~/server/jobs/update-user-score';
import type * as CreatorRemovals from '~/server/services/creator-removals.service';
import handler from '~/pages/api/admin/temp/recompute-reversed-removals';

function call(query: Record<string, string>) {
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    setHeader: () => res,
    end: () => res,
  };
  const req = { method: 'GET', headers: {}, query: { token: 'test-webhook-token', ...query } };
  return (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res).then(() => ({
    status,
    body,
  }));
}

// Owner 1 drops from three removals to two, owner 2 to none, owner 3 is already right, owner 4's
// stored score is behind its removal count (one stored, three counted), so its score falls.
// Owner 5 has a null stored score and no removals (unchanged); owner 6 has a null stored score and
// one removal (falls).
const STORED = { 1: -3000, 2: -1000, 3: -2000, 4: -1000, 5: null, 6: null } as Record<
  number,
  number | null
>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOwnersWithReversalsSince.mockResolvedValue([1, 2, 3, 4, 5, 6]);
  mocks.removalPenaltyWeightsByOwner.mockResolvedValue(
    new Map([
      [1, 2],
      [3, 2],
      [4, 3],
      [6, 1],
    ])
  );
  mocks.storedScores.mockImplementation((ids: number[]) =>
    ids.map((id) => ({ id, score: STORED[id] }))
  );
  mocks.applyUserScoreUpdates.mockImplementation(async (_pg, records: unknown[]) => records);
});

describe('recompute-reversed-removals', () => {
  it('counts what it would change and writes nothing by default', async () => {
    const { status, body } = await call({});

    expect(status).toBe(200);
    expect(body).toEqual({
      dryRun: true,
      direction: 'up',
      scope: 'reversed',
      owners: 6,
      changed: 2,
      up: 2,
      down: 2,
    });
    expect(mocks.applyUserScoreUpdates).not.toHaveBeenCalled();
  });

  it('re-scores every owner with a reversal ever, not only since the nightly checkpoint', async () => {
    await call({});

    expect(mocks.getOwnersWithReversalsSince).toHaveBeenCalledWith(expect.anything(), new Date(0));
    expect(mocks.removalPenaltyWeightsByOwner).toHaveBeenCalledWith(
      expect.anything(),
      [1, 2, 3, 4, 5, 6]
    );
  });

  it('writes only increases by default and leaves a decrease owner untouched', async () => {
    const { body } = await call({ dryRun: 'false' });

    expect(mocks.applyUserScoreUpdates).toHaveBeenCalledTimes(1);
    expect(mocks.applyUserScoreUpdates.mock.lastCall![1]).toEqual([
      ['1', { reportsAgainst: -2000 }],
      ['2', { reportsAgainst: 0 }],
    ]);
    expect(body).toEqual({
      dryRun: false,
      direction: 'up',
      scope: 'reversed',
      owners: 6,
      changed: 2,
      up: 2,
      down: 2,
      written: 2,
    });
  });

  it('direction=all writes the decrease as well', async () => {
    const { body } = await call({ dryRun: 'false', direction: 'all' });

    expect(mocks.applyUserScoreUpdates.mock.lastCall![1]).toEqual([
      ['1', { reportsAgainst: -2000 }],
      ['2', { reportsAgainst: 0 }],
      ['4', { reportsAgainst: -3000 }],
      ['6', { reportsAgainst: -1000 }],
    ]);
    expect(body).toEqual({
      dryRun: false,
      direction: 'all',
      scope: 'reversed',
      owners: 6,
      changed: 4,
      up: 2,
      down: 2,
      written: 4,
    });
  });

  it('dry run under direction=all counts the decrease in changed', async () => {
    const { body } = await call({ direction: 'all' });

    expect(body).toEqual({
      dryRun: true,
      direction: 'all',
      scope: 'reversed',
      owners: 6,
      changed: 4,
      up: 2,
      down: 2,
    });
    expect(mocks.applyUserScoreUpdates).not.toHaveBeenCalled();
  });

  it('direction=up behaves as the default', async () => {
    const { body } = await call({ dryRun: 'false', direction: 'up' });

    expect(mocks.applyUserScoreUpdates.mock.lastCall![1]).toEqual([
      ['1', { reportsAgainst: -2000 }],
      ['2', { reportsAgainst: 0 }],
    ]);
    expect(body).toMatchObject({ direction: 'up', changed: 2, written: 2 });
  });

  it('scope=all re-scores every owner with any removal, not only those with a reversal', async () => {
    mocks.getOwnersWithRemovals.mockResolvedValue([1, 2, 7]);
    mocks.removalPenaltyWeightsByOwner.mockResolvedValue(new Map([[7, 1]]));
    mocks.storedScores.mockImplementation((ids: number[]) =>
      ids.map((id) => ({ id, score: { 1: -1000, 2: 0, 7: -3000 }[id] ?? null }))
    );

    const { body } = await call({ scope: 'all', direction: 'all', dryRun: 'false' });

    expect(mocks.getOwnersWithReversalsSince).not.toHaveBeenCalled();
    expect(mocks.removalPenaltyWeightsByOwner).toHaveBeenCalledWith(expect.anything(), [1, 2, 7]);
    // Owner 1 has nothing left in the window; owner 7 has one removal of three left.
    expect(mocks.applyUserScoreUpdates.mock.lastCall![1]).toEqual([
      ['1', { reportsAgainst: 0 }],
      ['7', { reportsAgainst: -1000 }],
    ]);
    expect(body).toMatchObject({ scope: 'all', owners: 3, changed: 2, up: 2, down: 0 });
  });

  it('rejects an unknown direction before reading or writing anything', async () => {
    await expect(call({ direction: 'down' })).rejects.toThrow(/direction/);
    expect(mocks.getOwnersWithReversalsSince).not.toHaveBeenCalled();
    expect(mocks.applyUserScoreUpdates).not.toHaveBeenCalled();
  });
});
