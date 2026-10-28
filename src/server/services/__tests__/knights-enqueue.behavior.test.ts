import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { enqueueKnightsItems } from '~/server/services/knights/enqueue.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const dialect = (pg: PGlite): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await pg.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
};

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-11T10:00:00.000Z');

let pg: PGlite;
let db: Kysely<DB>;

const items = async () =>
  (
    await pg.query<{
      imageId: number;
      source: string;
      minRank: string;
      votesNeeded: number;
      priority: number;
      status: string;
      expiresAt: string | null;
      prediction: unknown;
    }>(
      `SELECT "imageId", "source", "minRank", "votesNeeded", "priority", "status", "expiresAt"::text, "prediction"
       FROM "KnightsQueueItem" ORDER BY "imageId"`
    )
  ).rows;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    `CREATE TABLE "Image" (id integer PRIMARY KEY, "needsReview" text, "acceptableMinor" boolean NOT NULL DEFAULT false);`
  );
  await pg.exec(migration('20261210120000_knights_v2_queue'));
  await pg.exec(migration('20261211120000_knights_v2_sources'));
  db = new Kysely<DB>({ dialect: dialect(pg) });
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM "KnightsQueueItem"; DELETE FROM "Image";`);
  await pg.exec(`INSERT INTO "Image" (id) VALUES (1), (2), (3), (4);`);
});

describe('enqueueKnightsItems', () => {
  it.each([
    ['held for review', `UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 1`],
    ['an acceptable minor', `UPDATE "Image" SET "acceptableMinor" = true WHERE id = 1`],
  ])('refuses an image that is %s and queues the rest', async (_label, hold) => {
    await pg.exec(hold);

    const outcomes = await enqueueKnightsItems(
      db,
      {
        source: 'owner-rating',
        questionKey: Q,
        items: [
          { imageId: 1, priority: 1 },
          { imageId: 2, priority: 1 },
        ],
      },
      NOW
    );

    expect(outcomes).toMatchObject([
      { imageId: 1, outcome: 'refused', reason: 'held-for-review' },
      { imageId: 2, outcome: 'enqueued' },
    ]);
    expect((await items()).map((i) => i.imageId)).toEqual([2]);
  });

  it('writes items with the question defaults and per-item overrides', async () => {
    const outcomes = await enqueueKnightsItems(
      db,
      {
        source: 'scan-sample',
        questionKey: Q,
        items: [
          { imageId: 1, priority: 1 },
          {
            imageId: 2,
            priority: 3,
            minRank: 'Templar',
            votesNeeded: 7,
            expiresAt: new Date('2026-12-20T00:00:00.000Z'),
            prediction: { value: '4' },
          },
          { imageId: 3, priority: 2, expiresAt: null },
        ],
      },
      NOW
    );

    expect(outcomes.map((o) => o.outcome)).toEqual(['enqueued', 'enqueued', 'enqueued']);
    expect(await items()).toEqual([
      {
        imageId: 1,
        source: 'scan-sample',
        minRank: 'Knight',
        votesNeeded: 5,
        priority: 1,
        status: 'Open',
        expiresAt: '2026-12-14 10:00:00',
        prediction: null,
      },
      {
        imageId: 2,
        source: 'scan-sample',
        minRank: 'Templar',
        votesNeeded: 7,
        priority: 3,
        status: 'Open',
        expiresAt: '2026-12-20 00:00:00',
        prediction: { value: '4' },
      },
      {
        imageId: 3,
        source: 'scan-sample',
        minRank: 'Knight',
        votesNeeded: 5,
        priority: 2,
        status: 'Open',
        expiresAt: null,
        prediction: null,
      },
    ]);
  });

  it('reports a repeat as a duplicate while the first is open, and writes nothing twice', async () => {
    const first = await enqueueKnightsItems(
      db,
      { source: 'a', questionKey: Q, items: [{ imageId: 1, priority: 1 }] },
      NOW
    );
    const again = await enqueueKnightsItems(
      db,
      {
        source: 'b',
        questionKey: Q,
        items: [
          { imageId: 1, priority: 1 },
          { imageId: 2, priority: 1 },
        ],
      },
      NOW
    );

    expect(first[0]).toMatchObject({ imageId: 1, outcome: 'enqueued' });
    expect(again).toMatchObject([
      { imageId: 1, outcome: 'duplicate' },
      { imageId: 2, outcome: 'enqueued' },
    ]);
    expect((await items()).map((i) => [i.imageId, i.source])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });

  it('treats an image repeated inside one batch as a duplicate', async () => {
    const outcomes = await enqueueKnightsItems(
      db,
      {
        source: 'a',
        questionKey: Q,
        items: [
          { imageId: 1, priority: 1 },
          { imageId: 1, priority: 2 },
        ],
      },
      NOW
    );

    expect(outcomes.map((o) => o.outcome)).toEqual(['enqueued', 'duplicate']);
    expect(await items()).toHaveLength(1);
  });

  it.each(['Resolved', 'Closed'])(
    'lets an image be asked again once its item is %s',
    async (status) => {
      await enqueueKnightsItems(
        db,
        { source: 'a', questionKey: Q, items: [{ imageId: 1, priority: 1 }] },
        NOW
      );
      await pg.query(`UPDATE "KnightsQueueItem" SET "status" = $1`, [status]);

      const [outcome] = await enqueueKnightsItems(
        db,
        { source: 'a', questionKey: Q, items: [{ imageId: 1, priority: 1 }] },
        NOW
      );

      expect(outcome.outcome).toBe('enqueued');
    }
  );

  it('keeps an image waiting on the Inquisitors from being asked again', async () => {
    await enqueueKnightsItems(
      db,
      { source: 'a', questionKey: Q, items: [{ imageId: 1, priority: 1 }] },
      NOW
    );
    await pg.query(
      `UPDATE "KnightsQueueItem" SET "status" = 'Inquisitor', "minRank" = 'Inquisitor'`
    );

    const [outcome] = await enqueueKnightsItems(
      db,
      { source: 'a', questionKey: Q, items: [{ imageId: 1, priority: 1 }] },
      NOW
    );

    expect(outcome.outcome).toBe('duplicate');
  });

  it('refuses what the queue could not serve, per item, and still writes the rest', async () => {
    const outcomes = await enqueueKnightsItems(
      db,
      {
        source: 'a',
        questionKey: Q,
        items: [
          { imageId: 1, priority: 1, minRank: 'Acolyte' },
          { imageId: 2, priority: 1, minRank: 'Inquisitor' },
          { imageId: 3, priority: 4 as never },
          { imageId: 4, priority: 1, votesNeeded: 0 },
          { imageId: 99, priority: 1 },
          { imageId: 4, priority: 1, expiresAt: new Date('2026-12-01T00:00:00.000Z') },
          { imageId: 4, priority: 1 },
        ],
      },
      NOW
    );

    expect(outcomes).toMatchObject([
      { imageId: 1, outcome: 'refused', reason: 'bad-rank' },
      { imageId: 2, outcome: 'refused', reason: 'bad-rank' },
      { imageId: 3, outcome: 'refused', reason: 'bad-priority' },
      { imageId: 4, outcome: 'refused', reason: 'bad-votes' },
      { imageId: 99, outcome: 'refused', reason: 'image-not-found' },
      { imageId: 4, outcome: 'refused', reason: 'bad-expiry' },
      { imageId: 4, outcome: 'enqueued' },
    ]);
    expect((await items()).map((i) => i.imageId)).toEqual([4]);
  });

  it('refuses every item of a question that is missing or switched off', async () => {
    await pg.query(
      `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options","active") VALUES ('off.q','choice','p','[]'::jsonb,false)`
    );

    const missing = await enqueueKnightsItems(
      db,
      { source: 'a', questionKey: 'nope', items: [{ imageId: 1, priority: 1 }] },
      NOW
    );
    const off = await enqueueKnightsItems(
      db,
      { source: 'a', questionKey: 'off.q', items: [{ imageId: 1, priority: 1 }] },
      NOW
    );

    expect(missing).toMatchObject([{ outcome: 'refused', reason: 'unknown-question' }]);
    expect(off).toMatchObject([{ outcome: 'refused', reason: 'inactive-question' }]);
    expect(await items()).toEqual([]);
  });

  it('has the database refuse a second open item for the same question and image', async () => {
    const insert = () =>
      pg.query(
        `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded") VALUES ($1, 1, 'a', 'Knight', 5)`,
        [Q]
      );
    await insert();
    await expect(insert()).rejects.toThrow(/KnightsQueueItem_open_question_image_key/);
  });
});
