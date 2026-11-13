import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ModelsSearchIndex from '~/server/search-index/models.search-index';

vi.mock('~/server/search-index/models.search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelsSearchIndex>()),
  modelsSearchIndex: { queueUpdate: async () => undefined },
}));

const { getCommentTasks } = await import('~/server/metrics/model.metrics');

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "CommentV3" (
      id int PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL, "userId" int NOT NULL,
      "deletedAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false
    );
    INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", "deletedAt", "tosViolation") VALUES
      (1, 'model', 100, 1, NULL, false),
      (2, 'model', 100, 2, NULL, false),
      (3, 'model', 100, 2, NULL, false),
      (4, 'model', 200, 1, NULL, false),
      (5, 'model', 300, 1, NULL, false),
      (6, 'model', 300, 2, NULL, false),
      (7, 'model', 300, 3, NULL, false),
      (8, 'model', 300, 4, now(), false),
      (9, 'model', 300, 5, NULL, true),
      (10, 'article', 300, 6, NULL, false),
      (11, 'model', 50, 1, NULL, false);
  `);
});
afterAll(async () => {
  await pg.close();
});

describe('model commentCount', () => {
  it('counts every affected model, in whatever order ClickHouse and the queue return them', async () => {
    const ctx = {
      lastUpdate: new Date('2026-11-01T00:00:00Z'),
      queue: [200],
      updates: {} as Record<number, Record<string, number>>,
      idKey: 'modelId',
      addAffected: () => undefined,
      jobContext: { checkIfCanceled: () => undefined, on: () => undefined },
      ch: {
        $query: async () => [{ modelId: 300 }, { modelId: 50 }, { modelId: 100 }, { modelId: 400 }],
      },
      pg: {
        cancellableQuery: async (sql: string, params: unknown[]) => ({
          cancel: () => undefined,
          result: async () => (await pg.query(sql, params)).rows,
        }),
      },
    };

    const tasks = await getCommentTasks(ctx as never);
    for (const task of tasks) await task();

    expect(ctx.updates).toEqual({
      50: { modelId: 50, commentCount: 1 },
      100: { modelId: 100, commentCount: 2 },
      200: { modelId: 200, commentCount: 1 },
      300: { modelId: 300, commentCount: 3 },
      400: { modelId: 400, commentCount: 0 },
    });
  });
});
