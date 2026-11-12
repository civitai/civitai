import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { comFaceRecheckRetryKey } from '~/server/services/model-com-face-recheck.service';
import { chunksFrom } from '../recompute-mature-model-nsfw-levels';
import {
  controlSql,
  insertRetryRowsSql,
  modActivitySql,
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
    CREATE TABLE "ModActivity" (id serial PRIMARY KEY, activity text, "entityType" text,
      "entityId" int, "createdAt" timestamp DEFAULT now());
  `);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`TRUNCATE "KeyValue"; TRUNCATE "Model"; TRUNCATE "ModActivity";`);
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

describe('the re-check set', () => {
  it('is every face not already waiting', async () => {
    await model(1);
    await model(3, { sfwName: null }); // no .com name
    await model(4, { sfwCoverImageId: null }); // no .com cover
    await model(5, { deletedAt: '2026-11-02T00:00:00Z' });
    await model(6); // already waiting on a re-check
    await db.query(`INSERT INTO "KeyValue" VALUES ($1, '{}'::jsonb)`, [comFaceRecheckRetryKey(6)]);

    expect(await run<{ id: number }>(recheckSetSql())).toEqual([{ id: 1 }]);
  });
});

describe('the re-check set, whatever the model was last written', () => {
  it('takes a face whose model had an unrelated write after the cutoff', async () => {
    await model(1, { updatedAt: '2026-11-12T00:00:00Z' }); // e.g. a lock toggle bumped updatedAt

    expect(await run<{ id: number }>(recheckSetSql())).toEqual([{ id: 1 }]);
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

    const result = await runBatches(chunksFrom([1, 2, 3, 4, 5], 2), 300_000, d);

    expect(inserted).toEqual([[1, 2]]);
    expect(result).toEqual({ queued: 2, stoppedAt: 3 });
  });

  it('keeps going while the checker answers some of each batch', async () => {
    const { inserted, deps: d } = deps((ids) => new Set(ids.slice(1)));

    const result = await runBatches(chunksFrom([1, 2, 3, 4, 5], 2), 300_000, d);

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

describe('readback controls', () => {
  const activity = (entityId: number, name: string, createdAt: string) =>
    db.query(
      `INSERT INTO "ModActivity" (activity, "entityType", "entityId", "createdAt") VALUES ($1, 'model', $2, $3)`,
      [name, entityId, createdAt]
    );

  it("counts the re-check's removals of these models since the run started", async () => {
    const since = new Date('2026-11-12T20:00:00Z');
    await activity(1, 'removeComFace', '2026-11-12T20:30:00Z');
    await activity(2, 'comFaceRecheckGaveUp', '2026-11-12T21:00:00Z');
    await activity(3, 'removeComFace', '2026-11-12T19:00:00Z'); // before the run
    await activity(4, 'removeComFace', '2026-11-12T20:30:00Z'); // not in the run
    await activity(3, 'lockModel', '2026-11-12T20:30:00Z'); // another activity, in the run

    const [{ count }] = await run<{ count: bigint }>(modActivitySql([1, 2, 3], since));

    expect(Number(count)).toBe(2);
  });

  it('sees a faced model outside the run that is waiting', async () => {
    await model(1);
    await model(2);
    await model(3, { sfwCoverImageId: null }); // no face
    await db.query(`INSERT INTO "KeyValue" VALUES ($1, '{}'::jsonb)`, [comFaceRecheckRetryKey(2)]);

    const [counts] = await run<{ total: bigint; pending: bigint }>(controlSql([1]));

    expect({ total: Number(counts.total), pending: Number(counts.pending) }).toEqual({
      total: 1,
      pending: 1,
    });
  });
});
