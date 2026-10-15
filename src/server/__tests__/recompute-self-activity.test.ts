import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyUserScoreUpdates: vi.fn(),
  writeSelfGenerations: vi.fn(),
  countSelfGenerations: vi.fn(),
  scoreModelOwners: vi.fn(),
  countSelfImageEngagement: vi.fn(),
  write: vi.fn(),
}));

const reads: Record<string, unknown[]> = {
  ModelMetric: [{ userId: 1 }, { userId: 2 }],
  CreatorMilestone: [{ key: 'score:supernova', threshold: 1_000_000 }],
  scores: [
    { id: 1, scores: { total: 1_000_100, models: 1_000_000, images: 100 } },
    { id: 3, scores: { total: 2_000_000, images: 2_000_000 } },
  ],
  imageOwners: [{ id: 1 }, { id: 3 }],
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
          : reads.imageOwners,
      cancel: async () => undefined,
    }),
  },
  pgDbWrite: {
    cancellableQuery: async (...args: unknown[]) => {
      mocks.write(...args);
      return { result: async () => [], cancel: async () => undefined };
    },
  },
}));
vi.mock('~/server/jobs/update-user-score', async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateUserScore>()),
  applyUserScoreUpdates: mocks.applyUserScoreUpdates,
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

// Owner 1 has self-generations and a self-reaction and falls below Supernova; owner 3 has only
// self-reactions and stays; owner 2 has neither.
beforeEach(() => {
  vi.clearAllMocks();
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
        ].filter(([id]) => owners.includes(id as number)) as [number, never][]
      )
  );
  mocks.applyUserScoreUpdates.mockImplementation(async (_pg, records: unknown[]) => records);
});

describe('recompute-self-activity', () => {
  it('reports by tier and writes nothing by default', async () => {
    const { status, body } = await call({});
    expect(status).toBe(200);
    expect(body).toMatchObject({
      dryRun: true,
      selfGenerators: 1,
      selfEngagers: 2,
      changed: 2,
      byTier: { 'score:supernova': { up: 0, down: 2, belowTier: 1 } },
    });
    expect(mocks.writeSelfGenerations).not.toHaveBeenCalled();
    expect(mocks.applyUserScoreUpdates).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('scores the models of the owners it found, from the rows it counted', async () => {
    await call({});
    const [, options] = mocks.scoreModelOwners.mock.calls[0];
    expect(options).toEqual({
      alsoRescore: [1],
      selfGenerations: [{ modelId: 50, userId: 1, generationCount: 1000 }],
    });
  });

  it('refuses to write without the cutoff', async () => {
    const { status } = await call({ dryRun: 'false' });
    expect(status).toBe(400);
    expect(mocks.applyUserScoreUpdates).not.toHaveBeenCalled();
    expect(mocks.writeSelfGenerations).not.toHaveBeenCalled();
  });

  it('writes the new scores and stamps the owners whose images changed', async () => {
    const before = '2026-11-01T00:00:00.000Z';
    const { body } = await call({ dryRun: 'false', before });
    expect(mocks.countSelfImageEngagement.mock.calls[0][2]).toEqual(new Date(before));
    expect(mocks.writeSelfGenerations).toHaveBeenCalledWith(
      expect.anything(),
      [1, 2],
      [{ modelId: 50, userId: 1, generationCount: 1000 }]
    );
    expect(mocks.applyUserScoreUpdates.mock.calls[0][1]).toEqual([
      ['1', { models: 999_000, images: 90 }],
      ['3', { images: 2_000_000 - 100 }],
    ]);
    const [stampSql, [, stamped]] = mocks.write.mock.calls[0] as [string, [string, number[]]];
    expect(stampSql).toContain('imageSelfExcludedAt');
    expect(stamped).toEqual([1, 3]);
    expect(body).toMatchObject({ written: 2 });
  });

  it('touches only images with part=images', async () => {
    await call({ part: 'images' });
    expect(mocks.countSelfGenerations).not.toHaveBeenCalled();
    expect(mocks.countSelfImageEngagement).toHaveBeenCalled();
  });
});
