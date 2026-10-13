import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chQuery: vi.fn(),
  storedScores: vi.fn(),
  applyUserScoreUpdates: vi.fn(),
  countRemovalsByOwner: vi.fn(),
  getImagesApprovedOnAppealSince: vi.fn(),
  getRemovedImageOwners: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { $query: mocks.chQuery },
}));
vi.mock('~/server/db/pgDb', async () => {
  const { createPgDbMock } = await import('~/test-utils/pgDbMock');
  return createPgDbMock({
    pgDbRead: {
      cancellableQuery: async (_sql: string, [ids]: [number[]]) => ({
        result: async () => mocks.storedScores(ids),
        cancel: async () => undefined,
      }),
    },
  });
});
vi.mock('~/server/jobs/update-user-score', async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateUserScore>()),
  applyUserScoreUpdates: mocks.applyUserScoreUpdates,
  getScoreMultipliers: async () => ({ reportsAgainst: -1000 }),
}));
vi.mock('~/server/services/creator-removals.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorRemovals>()),
  countRemovalsByOwner: mocks.countRemovalsByOwner,
  getImagesApprovedOnAppealSince: mocks.getImagesApprovedOnAppealSince,
  getRemovedImageOwners: mocks.getRemovedImageOwners,
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

// Owner 1 drops from three removals to two, owner 2 to none, owner 3 is already right.
const STORED = { 1: -3000, 2: -1000, 3: -2000 } as Record<number, number>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getImagesApprovedOnAppealSince.mockResolvedValue([10, 20]);
  mocks.getRemovedImageOwners.mockResolvedValue([1, 2]);
  mocks.chQuery.mockResolvedValue([{ ownerId: 3 }]);
  mocks.countRemovalsByOwner.mockResolvedValue(
    new Map([
      [1, 2],
      [3, 2],
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
    expect(body).toEqual({ dryRun: true, owners: 3, changed: 2 });
    expect(mocks.applyUserScoreUpdates).not.toHaveBeenCalled();
  });

  it('re-scores every owner with a reversed removal, from appeals and restore events', async () => {
    await call({});

    expect(mocks.getImagesApprovedOnAppealSince).toHaveBeenCalledWith(new Date(0));
    expect(mocks.getRemovedImageOwners).toHaveBeenCalledWith(expect.anything(), [10, 20]);
    expect(mocks.countRemovalsByOwner.mock.lastCall![1].sort()).toEqual([1, 2, 3]);
  });

  it('writes only the owners whose score changes', async () => {
    const { body } = await call({ dryRun: 'false' });

    expect(mocks.applyUserScoreUpdates).toHaveBeenCalledTimes(1);
    expect(mocks.applyUserScoreUpdates.mock.lastCall![1]).toEqual([
      ['1', { reportsAgainst: -2000 }],
      ['2', { reportsAgainst: 0 }],
    ]);
    expect(body).toEqual({ dryRun: false, owners: 3, changed: 2, written: 2 });
  });
});
