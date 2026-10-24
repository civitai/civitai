import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIdsOrThrow: vi.fn(async () => [EXCLUDED]),
}));

const { getCollectionTasks } = await import('~/server/metrics/article.metrics');

const AUTHOR = 1;
const SAVER = 2;
const OTHER = 3;
const EXCLUDED = 4;
const LEGACY_OWNER = 5;

const SAVED = 100;
const SELF_SAVED = 200;
const UNSAVED = 300;

let db: PGlite;

function makeCtx({
  eventIds,
  queue,
  lastUpdate,
}: {
  eventIds: number[];
  queue: number[];
  lastUpdate: Date;
}) {
  const updates: Record<number, Record<string, number>> = {};
  const ctx = {
    ch: { $query: vi.fn(async () => eventIds.map((entityId) => ({ entityId }))) },
    pg: {
      cancellableQuery: async (sql: string) => ({
        result: async () => (await db.query(sql)).rows,
        cancel: async () => undefined,
      }),
    },
    jobContext: { checkIfCanceled: () => undefined, on: () => undefined },
    queue,
    affected: new Set<number>(),
    addAffected: () => undefined,
    updates,
    idKey: 'articleId',
    lastUpdate,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { ctx, updates };
}

async function run(args: Parameters<typeof makeCtx>[0]) {
  const { ctx, updates } = makeCtx(args);
  const tasks = await getCollectionTasks(ctx);
  await Promise.all(tasks.map((t) => t()));
  return { ctx, updates };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Article" (id INT PRIMARY KEY, "userId" INT NOT NULL);
    CREATE TABLE "Collection" (id INT PRIMARY KEY, "userId" INT NOT NULL);
    CREATE TABLE "CollectionItem" (
      id SERIAL PRIMARY KEY, "collectionId" INT NOT NULL, "articleId" INT, "addedById" INT
    );
    INSERT INTO "Article" VALUES (${SAVED}, ${AUTHOR}), (${SELF_SAVED}, ${AUTHOR}), (${UNSAVED}, ${AUTHOR});
    INSERT INTO "Collection" VALUES
      (10, ${SAVER}), (11, ${SAVER}), (12, ${SAVER}),
      (20, ${OTHER}), (30, ${AUTHOR}), (40, ${EXCLUDED}), (50, ${LEGACY_OWNER});
    INSERT INTO "CollectionItem" ("collectionId", "articleId", "addedById") VALUES
      (10, ${SAVED}, ${SAVER}), (11, ${SAVED}, ${SAVER}), (12, ${SAVED}, ${SAVER}),
      (20, ${SAVED}, ${OTHER}),
      (30, ${SAVED}, ${AUTHOR}), (30, ${SELF_SAVED}, ${AUTHOR}),
      (40, ${SAVED}, ${EXCLUDED}),
      (50, ${SAVED}, NULL);
  `);
});

beforeEach(() => vi.clearAllMocks());

describe('article collectedCount', () => {
  it('counts each saver once, and not the author or an excluded account', async () => {
    // SAVER's three collections count once; OTHER once; the row with no adder counts its
    // collection's owner. AUTHOR's own save and EXCLUDED's save do not count.
    const { updates } = await run({
      eventIds: [SAVED, SELF_SAVED],
      queue: [],
      lastUpdate: new Date(0),
    });

    expect(updates[SAVED].collectedCount).toBe(3);
    expect(updates[SELF_SAVED].collectedCount).toBe(0);
  });

  it('writes zero for a queued article no one has saved', async () => {
    const { updates } = await run({ eventIds: [], queue: [UNSAVED], lastUpdate: new Date(0) });

    expect(updates[UNSAVED].collectedCount).toBe(0);
  });

  it('recounts queued articles between agg refreshes', async () => {
    // The backfill queues ids through the job; most runs fall between refreshes.
    const { ctx, updates } = await run({
      eventIds: [SAVED],
      queue: [SAVED],
      lastUpdate: new Date(),
    });

    expect(ctx.ch.$query).not.toHaveBeenCalled();
    expect(updates[SAVED].collectedCount).toBe(3);
  });
});
