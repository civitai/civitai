import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyUserScoreUpdates: vi.fn(),
  countSelfImageEngagement: vi.fn(),
  excluded: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: {
    $query: async () => [
      { imageId: 10, reactions: 5, comments: 1 }, // owner 1
      { imageId: 11, reactions: 3, comments: 0 }, // owner 2, metric-excluded
    ],
  },
}));
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  dataProcessor: async ({ processor }: { processor: (ctx: unknown) => Promise<void> }) =>
    processor({ start: 0, end: 100, cancelFns: [] }),
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: async (sql: string) => ({
      result: async () =>
        sql.includes('FROM "Image"')
          ? [
              { id: 10, userId: 1 },
              { id: 11, userId: 2 },
            ]
          : Promise.reject(new Error(`unexpected read: ${sql}`)),
      cancel: async () => undefined,
    }),
  },
  pgDbReadLong: {},
  pgDbWrite: {},
}));
vi.mock('~/server/jobs/update-user-score', async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateUserScore>()),
  applyUserScoreUpdates: mocks.applyUserScoreUpdates,
  getScoreMultipliers: async () => ({ images: { reactions: 10, comments: 20 } }),
}));
vi.mock('~/server/services/creator-score-self-activity.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SelfActivity>()),
  countSelfImageEngagement: mocks.countSelfImageEngagement,
}));
vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIdsOrThrow: mocks.excluded,
}));

import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as UpdateUserScore from '~/server/jobs/update-user-score';
import type * as SelfActivity from '~/server/services/creator-score-self-activity.service';
import handler from '~/pages/api/admin/temp/backfill-image-scores';

function call(query: Record<string, string>) {
  const res = {
    status: () => res,
    json: () => res,
    setHeader: () => res,
    end: () => res,
    on: () => res,
  };
  const req = { method: 'GET', headers: {}, query: { token: 'test-webhook-token', ...query } };
  return (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.excluded.mockResolvedValue([2]);
  mocks.countSelfImageEngagement.mockImplementation(
    async (_pg, owners: number[]) =>
      new Map(
        [
          [1, { reactions: 2, comments: 1 }],
          [2, { reactions: 3, comments: 0 }],
        ].filter(([id]) => owners.includes(id as number)) as [number, never][]
      )
  );
  mocks.applyUserScoreUpdates.mockResolvedValue([]);
});

describe('backfill-image-scores', () => {
  it("writes each owner's score less their own engagement, with both stamps, in one call", async () => {
    await call({ dryRun: 'false', force: 'true' });
    expect(mocks.countSelfImageEngagement).toHaveBeenCalledTimes(1);
    // The metric-excluded owner's reactions never reached the totals, so none of theirs come off.
    expect(mocks.countSelfImageEngagement.mock.calls[0][1]).toEqual([1]);
    expect(mocks.applyUserScoreUpdates).toHaveBeenCalledTimes(1);
    const [, records, , options] = mocks.applyUserScoreUpdates.mock.calls[0];
    expect(records).toEqual([
      ['1', { images: 5 * 10 + 1 * 20 - (2 * 10 + 1 * 20) }],
      ['2', { images: 3 * 10 }],
    ]);
    expect(options.stamp.keys).toEqual(['imageScoreRecomputedAt', 'imageSelfExcludedAt']);
    expect(options.stamp.at).toBeInstanceOf(Date);
  });

  it('writes nothing on a dry run', async () => {
    await call({});
    expect(mocks.applyUserScoreUpdates).not.toHaveBeenCalled();
    expect(mocks.countSelfImageEngagement).not.toHaveBeenCalled();
  });
});
