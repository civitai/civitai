import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  /** Runs after each read, to change a row between the job's read and its write. */
  afterRead: null as null | ((sql: string) => Promise<unknown>),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/db/pgDb', () => {
  const query = async (sql: string) => holder.db.query(sql);
  const read = async (sql: string) => {
    const result = await query(sql);
    await holder.afterRead?.(sql);
    return result;
  };
  return {
    pgDbRead: { query: read },
    pgDbReadLong: { query: read },
    pgDbWrite: {
      query,
      cancellableQuery: async (sql: string) => ({
        result: async () => (await holder.db.query(sql)).rows,
        cancel: async () => undefined,
      }),
    },
  };
});
vi.mock('~/server/jobs/apply-discord-roles', () => ({ applyDiscordLeaderboardRoles: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateLeaderboardRank: vi.fn() }));
vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIdsOrThrow: vi.fn(async () => []),
}));
vi.mock('~/server/services/leaderboard.service', () => ({
  getUnpopulatedLeaderboards: vi.fn(),
  isLeaderboardPopulated: vi.fn(),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  leaderboardJobs,
  setCoverImageNsfwLevel,
  setCoverImageNsfwLevelOrLog,
} from '../prepare-leaderboard';

const q = (sql: string, params?: unknown[]) => holder.db.query(sql, params);
const modelMeta = async (id: number) =>
  (await q(`SELECT meta FROM "Model" WHERE id = $1`, [id])).rows[0] as { meta: unknown };
const versionMeta = async (id: number) =>
  (await q(`SELECT meta FROM "ModelVersion" WHERE id = $1`, [id])).rows[0] as { meta: unknown };
const malformedLogs = () =>
  loggingMock.logToAxiom.mock.calls.filter(([e]) => e.name === 'leaderboard-malformed-meta');

/** A Published model whose first version's post carries `level`, with the model's meta as given. */
async function model(id: number, meta: string, level = 4) {
  await q(`INSERT INTO "Model" (id, "userId", meta) VALUES ($1, 1, $2::jsonb)`, [id, meta]);
  await q(
    `INSERT INTO "ModelVersion" (id, "modelId", status, index) VALUES ($1, $1, 'Published', 0)`,
    [id]
  );
  await q(
    `INSERT INTO "Post" (id, "modelVersionId", "userId", metadata) VALUES ($1, $1, 1, $2::jsonb)`,
    [id, JSON.stringify({ imageNsfwLevel: level })]
  );
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    -- As defined in prod.
    CREATE FUNCTION iif(condition boolean, true_result anyelement, false_result anyelement)
      RETURNS anyelement LANGUAGE sql IMMUTABLE
      AS 'SELECT CASE WHEN condition THEN true_result ELSE false_result END';
    CREATE TABLE "Model" (id INT PRIMARY KEY, "userId" INT NOT NULL, meta JSONB NOT NULL DEFAULT '{}');
    CREATE TABLE "ModelVersion" (
      id INT PRIMARY KEY, "modelId" INT NOT NULL, status TEXT NOT NULL, index INT,
      meta JSONB NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "Post" (id INT PRIMARY KEY, "modelVersionId" INT, "userId" INT NOT NULL, metadata JSONB);
  `);
});

beforeEach(async () => {
  loggingMock.logToAxiom.mockClear();
  holder.afterRead = null;
  await q(`TRUNCATE "Model", "ModelVersion", "Post"`);
});

describe('setCoverImageNsfwLevel with a model whose meta is not an object', () => {
  // `[null, {...}]` is what `COALESCE(meta, '{}') || x` writes over a JSON-null meta. On 2026-10-18 four
  // such rows made this step throw and the job built none of the 45 boards.
  it('still writes the level for every well-formed model and leaves the array row alone', async () => {
    await model(1, '{}');
    await model(2, '[null, {"a": 1}]');
    await model(3, 'null');

    await setCoverImageNsfwLevel();

    expect((await modelMeta(1)).meta).toEqual({ imageNsfwLevel: 4 });
    expect((await modelMeta(3)).meta).toEqual({ imageNsfwLevel: 4 });
    expect((await modelMeta(2)).meta).toEqual([null, { a: 1 }]);
    expect(malformedLogs()).toEqual([
      [expect.objectContaining({ error: expect.objectContaining({ table: 'Model', ids: [2] }) })],
    ]);
  });

  it('does the same for a version whose meta is not an object', async () => {
    await model(1, '{}');
    await model(2, '{}');
    await q(`UPDATE "ModelVersion" SET meta = '[null, {"a": 1}]'::jsonb WHERE id = 2`);

    await setCoverImageNsfwLevel();

    expect((await versionMeta(1)).meta).toEqual({ imageNsfwLevel: 4 });
    expect((await versionMeta(2)).meta).toEqual([null, { a: 1 }]);
    expect(malformedLogs()).toEqual([
      [
        expect.objectContaining({
          error: expect.objectContaining({ table: 'ModelVersion', ids: [2] }),
        }),
      ],
    ]);
  });

  it('skips a model whose meta became an array after it was read', async () => {
    await model(1, '{}');
    await model(2, '{"b": 1}');
    holder.afterRead = async (sql) => {
      if (sql.includes('model_nsfw_level'))
        await q(`UPDATE "Model" SET meta = '[null, {"b": 1}]'::jsonb WHERE id = 2`);
    };

    await setCoverImageNsfwLevel();

    expect((await modelMeta(1)).meta).toEqual({ imageNsfwLevel: 4 });
    expect((await modelMeta(2)).meta).toEqual([null, { b: 1 }]);
  });
});

describe('the prepare-leaderboard job', () => {
  it('still reads the boards when the cover level step throws', async () => {
    await q(`ALTER TABLE "Post" RENAME TO "PostGone"`);
    try {
      dbMock.dbWrite.leaderboard.findMany.mockResolvedValue([] as never);
      const job = leaderboardJobs.find((j) => j.name === 'prepare-leaderboard')!;
      // What happens after the boards are read is not this test's subject.
      await job.run({}).result.catch(() => undefined);
      expect(dbMock.dbWrite.leaderboard.findMany).toHaveBeenCalled();
      // The job ran the step through the wrapper, not around it.
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'leaderboard-cover-nsfw-level-failed' })
      );
    } finally {
      await q(`ALTER TABLE "PostGone" RENAME TO "Post"`);
    }
  });
});

describe('setCoverImageNsfwLevelOrLog', () => {
  it('resolves when the step throws, so the boards are still built', async () => {
    await q(`ALTER TABLE "Post" RENAME TO "PostGone"`);
    try {
      await expect(setCoverImageNsfwLevelOrLog()).resolves.toBeUndefined();
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'leaderboard-cover-nsfw-level-failed' })
      );
    } finally {
      await q(`ALTER TABLE "PostGone" RENAME TO "Post"`);
    }
  });
});
