import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * Runs the endpoint's real collection query against an in-process Postgres, through its real query
 * schema: a page of collections scanned by id, of which those whose cover may come from a minor or
 * SFW-only model are queued.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { queueCollectionsReindex } = vi.hoisted(() => ({
  queueCollectionsReindex: vi.fn(async (ids: number[], options: { dryRun: boolean }) => ({
    dryRun: options.dryRun,
    collectionCount: ids.length,
    queued: ids,
  })),
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
// The queueing and its read-back are queue-models-reindex's to pin.
vi.mock('~/server/search-index/queue-models-reindex', async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    '~/server/search-index/queue-models-reindex.schema'
  )),
  queueCollectionsReindex,
}));

const handler = (await import('~/pages/api/admin/temp/queue-held-cover-collections-reindex'))
  .default;

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, minor boolean NOT NULL DEFAULT false, "sfwOnly" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int);
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int);
    CREATE TABLE "Article" (id int PRIMARY KEY, "coverId" int, "bannerId" int);
    CREATE TABLE "Collection" (id int PRIMARY KEY, "imageId" int);
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int NOT NULL, "modelId" int, "postId" int, "imageId" int, "articleId" int
    );
    -- Model 1 is minor and model 2 SFW-only; model 3 is held by neither.
    INSERT INTO "Model" VALUES (1, true, false), (2, false, true), (3, false, false);
    INSERT INTO "ModelVersion" VALUES (10, 1), (20, 2), (30, 3);
    INSERT INTO "Post" VALUES (100, 10), (200, 20), (300, 30), (400, NULL);
    INSERT INTO "Image" VALUES (1000, 100), (1001, 100), (2000, 200), (3000, 300), (4000, 400);
    INSERT INTO "Article" VALUES (50, 1001, NULL), (51, NULL, 2000), (52, 3000, 3000);
    -- Collections 1-6 reach a held model by a model item, a post item, an image item, a stored
    -- cover, an article cover and an article banner. 7 reaches only model 3 by every path, 8 is
    -- empty, 9-11 hold nothing on a model, 12 reaches model 2 and 13 nothing.
    INSERT INTO "Collection" VALUES
      (1, NULL), (2, NULL), (3, NULL), (4, 1000), (5, NULL), (6, NULL), (7, 3000),
      (8, NULL), (9, NULL), (10, NULL), (11, NULL), (12, NULL), (13, NULL);
    INSERT INTO "CollectionItem" ("collectionId", "modelId", "postId", "imageId", "articleId") VALUES
      (1, 1, NULL, NULL, NULL), (2, NULL, 100, NULL, NULL), (3, NULL, NULL, 2000, NULL),
      (5, NULL, NULL, NULL, 50), (6, NULL, NULL, NULL, 51),
      (7, 3, NULL, NULL, NULL), (7, NULL, 300, NULL, NULL), (7, NULL, NULL, 3000, NULL),
      (7, NULL, NULL, NULL, 52),
      (9, NULL, 400, NULL, NULL), (10, NULL, NULL, 4000, NULL), (11, NULL, NULL, NULL, NULL),
      (12, 2, NULL, NULL, NULL), (13, NULL, NULL, 4000, NULL);
  `);
  for (const client of [dbMock.dbRead, dbMock.dbWrite])
    (client.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      pgliteRaw(db).queryRaw
    );
});

type Page = {
  queued: number[];
  dryRun: boolean;
  scanned: number;
  matched: number;
  nextCursor: number | null;
  done: boolean;
};

async function call(query: Record<string, string>) {
  const req = {
    method: 'POST',
    query: { token: 'test-webhook-token', ...query },
    headers: {},
  } as never;
  let statusCode = 0;
  let body = {} as Page;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json: (sent: Page) => {
      body = sent;
      return res;
    },
    send: () => res,
    setHeader: () => res,
  };
  await handler(req, res as never);
  return { statusCode, body };
}

describe('queue-held-cover-collections-reindex', () => {
  it('queues the collections reaching a held model by each path, and not one reaching only an unheld model', async () => {
    const { statusCode, body } = await call({ collections: '100', dryRun: 'true' });
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      dryRun: true,
      queued: [1, 2, 3, 4, 5, 6, 12],
      scanned: 13,
      matched: 7,
      nextCursor: null,
      done: true,
    });
  });

  it('advances past a page with no match', async () => {
    const { body } = await call({ cursor: '8', collections: '3' });
    expect(body).toMatchObject({ queued: [], scanned: 3, matched: 0, nextCursor: 11, done: false });
  });

  it('queues a match on the last scanned id and resumes after it', async () => {
    const first = await call({ cursor: '8', collections: '4' });
    expect(first.body).toMatchObject({ queued: [12], scanned: 4, nextCursor: 12, done: false });

    const next = await call({ cursor: '12', collections: '4' });
    expect(next.body).toMatchObject({ queued: [], scanned: 1, nextCursor: null, done: true });
  });

  it('ends at a cursor past the last collection', async () => {
    const { body } = await call({ cursor: '1000' });
    expect(body).toMatchObject({
      queued: [],
      scanned: 0,
      matched: 0,
      nextCursor: null,
      done: true,
    });
  });
});
