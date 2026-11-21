import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * Runs the endpoint's real collection query against an in-process Postgres: a page of collections
 * scanned by id, of which those whose cover may come from a minor or SFW-only model are selected.
 * The route runs as a dry run, so nothing is queued.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));

const handler = (
  await import('~/server/api-routes/admin/temp/queue-held-cover-collections-reindex')
).default;
const { getCollectionPageCoveredByHeldModels } = await import(
  '~/server/services/collection-index-sync'
);

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE "CollectionReadConfiguration" AS ENUM ('Private', 'Public', 'Unlisted');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TABLE "Model" (
      id int PRIMARY KEY, minor boolean NOT NULL DEFAULT false, "sfwOnly" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int);
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int);
    CREATE TABLE "Article" (id int PRIMARY KEY, "coverId" int, "bannerId" int);
    CREATE TABLE "Collection" (
      id int PRIMARY KEY, "imageId" int, "userId" int NOT NULL DEFAULT 1,
      read "CollectionReadConfiguration" NOT NULL DEFAULT 'Public',
      availability "Availability" NOT NULL DEFAULT 'Public'
    );
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
    -- empty, 9-11 hold nothing on a model, 12 reaches model 2 and 13 nothing. 14-18 reach model 1
    -- but are not in the search index: private, unsearchable, the system user's, unlisted, empty.
    INSERT INTO "Collection" VALUES
      (1, NULL), (2, NULL), (3, NULL), (4, 1000), (5, NULL), (6, NULL), (7, 3000),
      (8, NULL), (9, NULL), (10, NULL), (11, NULL), (12, NULL), (13, NULL);
    INSERT INTO "Collection" (id, "imageId", "userId", read, availability) VALUES
      (14, NULL, 1, 'Private', 'Public'), (15, NULL, 1, 'Public', 'Unsearchable'),
      (16, NULL, -1, 'Public', 'Public'), (17, NULL, 1, 'Unlisted', 'Public'),
      (18, 1000, 1, 'Public', 'Public');
    INSERT INTO "CollectionItem" ("collectionId", "modelId", "postId", "imageId", "articleId") VALUES
      (1, 1, NULL, NULL, NULL), (2, NULL, 100, NULL, NULL), (3, NULL, NULL, 2000, NULL),
      (5, NULL, NULL, NULL, 50), (6, NULL, NULL, NULL, 51),
      (7, 3, NULL, NULL, NULL), (7, NULL, 300, NULL, NULL), (7, NULL, NULL, 3000, NULL),
      (7, NULL, NULL, NULL, 52),
      (9, NULL, 400, NULL, NULL), (10, NULL, NULL, 4000, NULL), (11, NULL, NULL, NULL, NULL),
      (12, 2, NULL, NULL, NULL), (13, NULL, NULL, 4000, NULL), (4, NULL, NULL, 4000, NULL),
      (14, 1, NULL, NULL, NULL), (15, 1, NULL, NULL, NULL), (16, 1, NULL, NULL, NULL),
      (17, 1, NULL, NULL, NULL);
  `);
  for (const client of [dbMock.dbRead, dbMock.dbWrite])
    (client.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      pgliteRaw(db).queryRaw
    );
});

type Page = {
  dryRun: boolean;
  collectionCount: number;
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

describe('getCollectionPageCoveredByHeldModels', () => {
  it('selects the collections reaching a held model by each path, and not one reaching only an unheld model', async () => {
    expect(await getCollectionPageCoveredByHeldModels({ cursor: 0, limit: 100 })).toEqual({
      collectionIds: [1, 2, 3, 4, 5, 6, 12],
      scanned: 18,
      lastScannedId: 18,
    });
  });

  it('skips a collection the search index does not hold, though it reaches a held model', async () => {
    expect(await getCollectionPageCoveredByHeldModels({ cursor: 13, limit: 100 })).toEqual({
      collectionIds: [],
      scanned: 5,
      lastScannedId: 18,
    });
  });
});

describe('queue-held-cover-collections-reindex', () => {
  it('reports the page it scanned as a dry run', async () => {
    const { statusCode, body } = await call({ collections: '100' });
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      dryRun: true,
      collectionCount: 7,
      scanned: 18,
      matched: 7,
      nextCursor: null,
      done: true,
    });
  });

  it('advances past a page with no match', async () => {
    const { body } = await call({ cursor: '8', collections: '3' });
    expect(body).toMatchObject({ matched: 0, scanned: 3, nextCursor: 11, done: false });
  });

  it('counts a match on the last scanned id and resumes after it', async () => {
    const first = await call({ cursor: '8', collections: '4' });
    expect(first.body).toMatchObject({ matched: 1, scanned: 4, nextCursor: 12, done: false });

    const next = await call({ cursor: '12', collections: '10' });
    expect(next.body).toMatchObject({ matched: 0, scanned: 6, nextCursor: null, done: true });
  });

  it('ends at a cursor past the last collection', async () => {
    const { body } = await call({ cursor: '1000' });
    expect(body).toMatchObject({ matched: 0, scanned: 0, nextCursor: null, done: true });
  });
});
