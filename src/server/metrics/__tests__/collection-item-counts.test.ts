import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const excluded = vi.hoisted(() => ({ ids: [] as number[] }));
vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIdsOrThrow: async () => excluded.ids,
}));

import {
  LOOKBACK_MS,
  collectionItemCountSql,
  getCollectionItemCountTasks,
} from '~/server/metrics/collection-item-counts';

let pg: PGlite;

beforeEach(async () => {
  excluded.ids = [];
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "CollectionMode" AS ENUM ('Contest', 'Bookmark');
    CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');
    CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int, mode "CollectionMode");
    CREATE TABLE "CollectionItem" (
      id int PRIMARY KEY, "collectionId" int, "articleId" int, "modelId" int, "postId" int,
      "imageId" int, "addedById" int, status "CollectionItemStatus" NOT NULL DEFAULT 'ACCEPTED');
    INSERT INTO "Collection" VALUES
      (1, 5, 'Bookmark'), (2, 5, NULL), (3, 5, NULL), (4, 6, 'Bookmark'), (7, 8, 'Contest');
    INSERT INTO "CollectionItem" (id, "collectionId", "articleId", "imageId", "addedById", status) VALUES
      (1, 1, 30, NULL, NULL, 'ACCEPTED'),  -- user 5's bookmark, written without an adder
      (2, 2, 30, NULL, 5, 'ACCEPTED'),     -- user 5 again, in a second collection
      (3, 3, 30, NULL, 5, 'ACCEPTED'),     -- and a third
      (4, 4, 30, NULL, 6, 'ACCEPTED'),     -- user 6
      (5, 7, 31, NULL, 9, 'REVIEW'),       -- still in review: in no one's collection yet
      (6, 4, 31, NULL, 6, 'ACCEPTED'),
      (7, 2, 32, NULL, 77, 'ACCEPTED'),    -- by a metric-excluded user, in the tests that say so
      (8, 3, 33, NULL, NULL, 'ACCEPTED'),  -- no adder outside a Bookmark collection: no collector
      (9, 1, NULL, 90, 5, 'REVIEW'),       -- an image in review, in collection 1
      (10, 4, 34, NULL, NULL, 'ACCEPTED'), -- user 6's only copy, a bookmark with no adder
      (11, 8, 35, NULL, NULL, 'ACCEPTED');  -- a Bookmark collection with no real owner
    INSERT INTO "Collection" VALUES (8, 0, 'Bookmark');
  `);
});

afterEach(async () => {
  await pg.close();
});

async function countsOf(entityType: 'Article' | 'Collection', ids: number[]) {
  const params = entityType === 'Collection' ? [ids] : [ids, excluded.ids];
  const { rows } = await pg.query<{ id: number; n: number }>(
    collectionItemCountSql(entityType),
    params
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}

describe('collectedCount', () => {
  // The leaderboards read this. Counted per row, user 5's three copies made article 30 a 4.
  it('counts each collector once, however many of their collections hold it', async () => {
    expect(await countsOf('Article', [30])).toEqual({ 30: 2 });
  });

  it('counts a bookmark written without an adder as its collection owner', async () => {
    expect(await countsOf('Article', [34])).toEqual({ 34: 1 });
  });

  it('does not take an owner id of 0 for a collector', async () => {
    expect(await countsOf('Article', [35])).toEqual({});
  });

  it('keeps counting a collector until their last copy is gone', async () => {
    await pg.exec(`DELETE FROM "CollectionItem" WHERE id = 2`);
    expect(await countsOf('Article', [30])).toEqual({ 30: 2 });
    await pg.exec(`DELETE FROM "CollectionItem" WHERE id IN (1, 3)`);
    expect(await countsOf('Article', [30])).toEqual({ 30: 1 });
  });

  it('counts only ACCEPTED rows', async () => {
    expect(await countsOf('Article', [31])).toEqual({ 31: 1 });
    await pg.exec(`UPDATE "CollectionItem" SET status = 'ACCEPTED' WHERE id = 5`);
    expect(await countsOf('Article', [31])).toEqual({ 31: 2 });
  });

  it('leaves out metric-excluded collectors and rows with no collector', async () => {
    expect(await countsOf('Article', [32, 33])).toEqual({ 32: 1 });
    excluded.ids = [77];
    expect(await countsOf('Article', [32, 33])).toEqual({});
  });
});

describe('itemCount', () => {
  it('counts every ACCEPTED row of the collection, duplicates of a collector included', async () => {
    expect(await countsOf('Collection', [1, 2, 7])).toEqual({ 1: 1, 2: 2 });
  });
});

describe('getCollectionItemCountTasks', () => {
  const NOW = new Date('2026-10-24T18:07:00Z');
  afterEach(() => vi.useRealTimers());

  function context(lastUpdate: Date, queue: number[] = []) {
    const chCalls: unknown[][] = [];
    const updates: Record<number, Record<string, number>> = {};
    const ctx = {
      pg: {
        cancellableQuery: async (sql: string, params: unknown[]) => ({
          cancel: () => undefined,
          result: async () => (await pg.query(sql, params)).rows,
        }),
      },
      ch: {
        $query: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
          chCalls.push(values);
          return [{ entityId: 30 }, { entityId: 31 }];
        },
      },
      jobContext: { checkIfCanceled: () => undefined, on: () => undefined },
      lastUpdate,
      queue,
      updates,
      idKey: 'articleId',
    };
    const run = async () => {
      const tasks = await getCollectionItemCountTasks(ctx as never)('Article');
      for (const task of tasks) await task();
    };
    return { run, chCalls, updates };
  }

  it('recounts entities with events since well before the last run, for this metric only', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const lastUpdate = new Date(NOW.getTime() - 6 * 60 * 1000);
    const { run, chCalls } = context(lastUpdate);
    await run();
    expect(chCalls).toEqual([
      ['Article', 'collectedCount', new Date(lastUpdate.getTime() - LOOKBACK_MS)],
    ]);
  });

  it('reads ClickHouse once per five minutes, and still recounts the queue in between', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { run, chCalls, updates } = context(new Date(NOW.getTime() - 60 * 1000), [34]);
    await run();
    expect(chCalls).toEqual([]);
    expect(updates).toEqual({ 34: { articleId: 34, collectedCount: 1 } });
  });

  it('writes 0 for an affected entity with no rows left, so the old value does not stand', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await pg.exec(`DELETE FROM "CollectionItem" WHERE "articleId" = 31`);
    const { run, updates } = context(new Date(NOW.getTime() - 6 * 60 * 1000));
    await run();
    expect(updates).toEqual({
      30: { articleId: 30, collectedCount: 2 },
      31: { articleId: 31, collectedCount: 0 },
    });
  });
});
