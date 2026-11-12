import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { comFaceRecheckRetryKey } from '~/server/services/model-com-face-recheck.service';
import {
  batches,
  insertRetryRowsSql,
  pendingSql,
  readbackSql,
  recheckSetSql,
  runBatches,
} from '../recheck-com-faces';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb NOT NULL);
    CREATE TABLE "Model" (id int PRIMARY KEY, "sfwName" text, "sfwCoverImageId" int,
      "deletedAt" timestamp, "updatedAt" timestamp, meta jsonb DEFAULT '{}');
  `);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`TRUNCATE "KeyValue"; TRUNCATE "Model";`);
});

const run = async <T>(sql: Prisma.Sql) => (await db.query<T>(sql.text, sql.values)).rows;
const model = (id: number, over: Record<string, unknown> = {}) => {
  const row = {
    sfwName: 'Name',
    sfwCoverImageId: 100 + id,
    deletedAt: null,
    updatedAt: '2026-11-01T00:00:00Z',
    meta: {},
    ...over,
  };
  return db.query(`INSERT INTO "Model" VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [
    id,
    row.sfwName,
    row.sfwCoverImageId,
    row.deletedAt,
    row.updatedAt,
    JSON.stringify(row.meta),
  ]);
};
const rowOf = async (id: number) =>
  (
    await db.query<{ value: unknown }>(`SELECT value FROM "KeyValue" WHERE key = $1`, [
      comFaceRecheckRetryKey(id),
    ])
  ).rows[0]?.value;

const CUTOFF = new Date('2026-11-07T17:42:13Z');

describe('the re-check set', () => {
  it('is every face last saved before the cutoff that is not already waiting', async () => {
    await model(1);
    await model(2, { updatedAt: '2026-11-08T00:00:00Z' }); // saved after the cutoff
    await model(3, { sfwName: null }); // no .com name
    await model(4, { sfwCoverImageId: null }); // no .com cover
    await model(5, { deletedAt: '2026-11-02T00:00:00Z' });
    await model(6); // already waiting on a re-check
    await db.query(`INSERT INTO "KeyValue" VALUES ($1, '{}'::jsonb)`, [comFaceRecheckRetryKey(6)]);

    expect(await run<{ id: number }>(recheckSetSql(CUTOFF))).toEqual([{ id: 1 }]);
  });
});

describe('queuing', () => {
  it('writes the due retry row the re-check job reads', async () => {
    await run(insertRetryRowsSql([7], new Date('2026-11-12T20:00:00.000Z')));

    expect(await rowOf(7)).toEqual({ since: '2026-11-12T20:00:00.000Z', attempt: 0, nextAt: '' });
  });

  it('leaves a model already waiting as it was, deadline and backoff', async () => {
    const waiting = {
      since: '2026-11-12T08:00:00.000Z',
      attempt: 3,
      nextAt: '2026-11-12T21:00:00.000Z',
    };
    await db.query(`INSERT INTO "KeyValue" VALUES ($1, $2::jsonb)`, [
      comFaceRecheckRetryKey(7),
      JSON.stringify(waiting),
    ]);

    await run(insertRetryRowsSql([7, 8], new Date('2026-11-12T20:00:00.000Z')));

    expect(await rowOf(7)).toEqual(waiting);
    expect(await rowOf(8)).toMatchObject({ attempt: 0 });
  });

  it('reads back which of a batch are still waiting', async () => {
    await run(insertRetryRowsSql([7, 8], new Date()));
    await db.query(`DELETE FROM "KeyValue" WHERE key = $1`, [comFaceRecheckRetryKey(8)]);

    expect(await run<{ id: number }>(pendingSql([7, 8, 9]))).toEqual([{ id: 7 }]);
  });
});

describe('the stop guard', () => {
  const deps = (pending: (ids: number[]) => Set<number>) => {
    const inserted: number[][] = [];
    return {
      inserted,
      deps: {
        insert: async (ids: number[]) => (inserted.push(ids), ids.length),
        pending: async (ids: number[]) => pending(ids),
        sleep: vi.fn(async () => undefined),
        log: vi.fn(),
      },
    };
  };

  it('stops before the next batch when no row of the last one got a verdict', async () => {
    const { inserted, deps: d } = deps((ids) => new Set(ids));

    const result = await runBatches(batches([1, 2, 3, 4, 5], 2), 300_000, d);

    expect(inserted).toEqual([[1, 2]]);
    expect(result).toEqual({ queued: 2, stoppedAt: 3 });
  });

  it('keeps going while the checker answers some of each batch', async () => {
    const { inserted, deps: d } = deps((ids) => new Set(ids.slice(1)));

    const result = await runBatches(batches([1, 2, 3, 4, 5], 2), 300_000, d);

    expect(inserted).toEqual([[1, 2], [3, 4], [5]]);
    expect(result).toEqual({ queued: 5, stoppedAt: undefined });
  });
});

describe('readback', () => {
  it('counts kept, removed, unverified and still waiting', async () => {
    await model(1); // kept
    await model(2, { sfwCoverImageId: null, meta: { comFaceRemoved: { reason: 'detected' } } });
    await model(3, {
      sfwCoverImageId: null,
      meta: { comFaceRemoved: { reason: 'recheck-unverified' } },
    });
    await model(4); // waiting
    await db.query(`INSERT INTO "KeyValue" VALUES ($1, '{}'::jsonb)`, [comFaceRecheckRetryKey(4)]);

    const [counts] = await run<Record<string, bigint>>(readbackSql([1, 2, 3, 4]));

    expect(Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)]))).toEqual({
      pending: 1,
      kept: 1,
      removed: 1,
      unverified: 1,
      total: 4,
    });
  });
});
