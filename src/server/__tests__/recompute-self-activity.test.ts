import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyUserScoreUpdates: vi.fn(),
  subtractImagesScores: vi.fn(),
  writeSelfGenerations: vi.fn(),
  countSelfGenerations: vi.fn(),
  scoreModelOwners: vi.fn(),
  countSelfImageEngagement: vi.fn(),
  listImageOwnersToExclude: vi.fn(),
  excluded: vi.fn(),
  recorded: [] as { value: number }[],
}));

const reads: Record<string, unknown[]> = {
  ModelMetric: [{ userId: 1 }, { userId: 2 }],
  CreatorMilestone: [{ key: 'score:supernova', threshold: 1_000_000 }],
  scores: [
    { id: 1, scores: { total: 1_000_100, models: 1_000_000, images: 100 } },
    { id: 3, scores: { total: 2_000_000, images: 2_000_000 } },
  ],
};

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: {},
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {},
  pgDbReadLong: {
    cancellableQuery: async (sql: string) => ({
      result: async () =>
        sql.includes('"ModelMetric"')
          ? reads.ModelMetric
          : sql.includes('"CreatorMilestone"')
          ? reads.CreatorMilestone
          : sql.includes("meta->'scores' AS scores")
          ? reads.scores
          : Promise.reject(new Error(`unexpected read: ${sql}`)),
      cancel: async () => undefined,
    }),
  },
  pgDbWrite: {
    cancellableQuery: async (sql: string) => ({
      result: async () =>
        sql.includes('"KeyValue"')
          ? mocks.recorded
          : Promise.reject(new Error(`unexpected write: ${sql}`)),
      cancel: async () => undefined,
    }),
  },
}));
vi.mock('~/server/jobs/update-user-score', async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateUserScore>()),
  applyUserScoreUpdates: mocks.applyUserScoreUpdates,
  subtractImagesScores: mocks.subtractImagesScores,
  writeSelfGenerations: mocks.writeSelfGenerations,
  countSelfGenerations: mocks.countSelfGenerations,
  scoreModelOwners: mocks.scoreModelOwners,
  getScoreMultipliers: async () => ({
    models: { reviews: 10, downloads: 1, generations: 1 },
    images: { reactions: 10, comments: 20 },
  }),
}));
vi.mock('~/server/services/creator-score-self-activity.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SelfActivity>()),
  countSelfImageEngagement: mocks.countSelfImageEngagement,
  listImageOwnersToExclude: mocks.listImageOwnersToExclude,
}));
vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIdsOrThrow: mocks.excluded,
}));

import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as UpdateUserScore from '~/server/jobs/update-user-score';
import type * as SelfActivity from '~/server/services/creator-score-self-activity.service';
import handler from '~/pages/api/admin/temp/recompute-self-activity';

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
    body: body as Record<string, unknown>,
  }));
}

const CUTOFF = new Date('2026-10-30T23:55:00.000Z');

// Owner 1 has self-generations and a self-reaction and falls below Supernova; owner 3 has only
// self-reactions and stays; owner 2 has neither; owner 4 is metric-excluded.
beforeEach(() => {
  vi.clearAllMocks();
  mocks.recorded = [{ value: CUTOFF.getTime() }];
  mocks.excluded.mockResolvedValue([4]);
  mocks.listImageOwnersToExclude.mockResolvedValue([1, 3, 4]);
  mocks.countSelfGenerations.mockImplementation(async (_ch, _pg, owners: number[]) =>
    owners.includes(1) ? [{ modelId: 50, userId: 1, generationCount: 1000 }] : []
  );
  mocks.scoreModelOwners.mockImplementation(async (ctx, { alsoRescore }) => {
    for (const id of alsoRescore) ctx.setScore(id, 'models', 999_000);
  });
  mocks.countSelfImageEngagement.mockImplementation(
    async (_pg, owners: number[]) =>
      new Map(
        [
          [1, { reactions: 1, comments: 0 }],
          [3, { reactions: 10, comments: 0 }],
          [4, { reactions: 99, comments: 0 }],
        ].filter(([id]) => owners.includes(id as number)) as [number, never][]
      )
  );
  mocks.applyUserScoreUpdates.mockImplementation(async (_pg, records: unknown[]) => records);
  mocks.subtractImagesScores.mockImplementation(async (_pg, rows: unknown[]) => rows);
});

describe('recompute-self-activity', () => {
  it('reports by tier and writes nothing by default', async () => {
    const { status, body } = await call({});
    expect(status).toBe(200);
    expect(body).toMatchObject({
      dryRun: true,
      selfGenerators: 1,
      imageOwners: 2,
      selfEngagers: 2,
      changed: 2,
      byTier: { 'score:supernova': { up: 0, down: 2, belowTier: 1 } },
    });
    expect(mocks.writeSelfGenerations).not.toHaveBeenCalled();
    expect(mocks.applyUserScoreUpdates).not.toHaveBeenCalled();
    expect(mocks.subtractImagesScores).not.toHaveBeenCalled();
  });

  it('cuts own engagement off where the nightly job started leaving it out', async () => {
    await call({});
    expect(mocks.countSelfImageEngagement.mock.calls[0][2]).toEqual(CUTOFF);
  });

  it('leaves metric-excluded owners alone', async () => {
    await call({ dryRun: 'false' });
    expect(mocks.countSelfImageEngagement.mock.calls[0][1]).toEqual([1, 3]);
  });

  it('scores the models of the owners it found, from the rows it counted', async () => {
    await call({});
    const [ctx, options] = mocks.scoreModelOwners.mock.calls[0];
    // Past every checkpoint, so the scorer re-scores only the owners it is handed.
    expect(ctx.lastUpdate.getTime()).toBeGreaterThan(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    expect(options).toEqual({
      alsoRescore: [1],
      selfGenerations: [{ modelId: 50, userId: 1, generationCount: 1000 }],
    });
  });

  it('refuses to write images before the nightly job has recorded its cutoff', async () => {
    mocks.recorded = [];
    const { status } = await call({ dryRun: 'false' });
    expect(status).toBe(409);
    expect(mocks.applyUserScoreUpdates).not.toHaveBeenCalled();
    expect(mocks.subtractImagesScores).not.toHaveBeenCalled();
    expect(mocks.writeSelfGenerations).not.toHaveBeenCalled();
  });

  it('still dry-runs, and writes models only, before the cutoff is recorded', async () => {
    mocks.recorded = [];
    expect((await call({})).status).toBe(200);
    const { status } = await call({ dryRun: 'false', part: 'models' });
    expect(status).toBe(200);
    expect(mocks.applyUserScoreUpdates).toHaveBeenCalledTimes(1);
    expect(mocks.subtractImagesScores).not.toHaveBeenCalled();
  });

  it('writes models as absolute scores and images as stamped subtractions', async () => {
    const { body } = await call({ dryRun: 'false' });
    expect(mocks.writeSelfGenerations).toHaveBeenCalledWith(
      expect.anything(),
      [1, 2],
      [{ modelId: 50, userId: 1, generationCount: 1000 }]
    );
    expect(mocks.applyUserScoreUpdates).toHaveBeenCalledTimes(1);
    expect(mocks.subtractImagesScores).toHaveBeenCalledTimes(1);
    expect(mocks.applyUserScoreUpdates.mock.calls[0][1]).toEqual([['1', { models: 999_000 }]]);
    const [, rows, stamp] = mocks.subtractImagesScores.mock.calls[0];
    expect(rows).toEqual([
      [1, 10],
      [3, 100],
    ]);
    expect(stamp.key).toBe('imageSelfExcludedAt');
    expect(body).toMatchObject({ modelsWritten: 1, imagesWritten: 2 });
  });

  it('touches only images with part=images', async () => {
    await call({ part: 'images' });
    expect(mocks.countSelfGenerations).not.toHaveBeenCalled();
    expect(mocks.countSelfImageEngagement).toHaveBeenCalled();
  });
});
