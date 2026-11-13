import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { Prisma } from '@prisma/client';

/**
 * The child-label reindex route's work, with its SQL run on an in-memory Postgres (only the columns
 * the SQL reads): which images it selects, that a dry run writes nothing, that a real bust refreshes
 * exactly the selected images and stops when the refreshed entries still lack the label, and which
 * models and collections a reindex queues.
 */

const { refresh, fetch, queueModelsReindex, collectionsQueueUpdate } = vi.hoisted(() => ({
  refresh: vi.fn(async (_ids: number[]) => undefined),
  fetch: vi.fn(),
  queueModelsReindex: vi.fn(async (ids: number[], opts: { dryRun: boolean }) => ({
    dryRun: opts.dryRun,
    modelCount: ids.length,
  })),
  collectionsQueueUpdate: vi.fn(async (_items: { id: number }[]) => undefined),
}));
vi.mock('~/server/redis/caches', () => ({ tagIdsForImagesCache: { refresh, fetch } }));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: collectionsQueueUpdate },
}));
vi.mock('~/server/search-index/queue-models-reindex', () => ({ queueModelsReindex }));

const { runChildLabelReindex } = await import('~/server/services/child-label-reindex.service');

const CHILD = childBrowsingTagIds[0];
const OTHER = 9002;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "TagSource" AS ENUM ('User', 'Rekognition', 'WD14');
    CREATE TABLE "TagsOnImageDetails" (
      "imageId" int NOT NULL, "tagId" int NOT NULL, source "TagSource" NOT NULL,
      disabled boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Article" (id int PRIMARY KEY, "coverId" int, "bannerId" int);
    CREATE TABLE "Model3D" (id int PRIMARY KEY, "thumbnailImageId" int);
    CREATE TABLE "Collection" (id int PRIMARY KEY, "imageId" int);
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int NOT NULL, "imageId" int, "postId" int,
      "modelId" int, "articleId" int, "model3dId" int
    );
  `);
});
afterAll(() => db.close());

let queries = 0;
beforeEach(async () => {
  vi.clearAllMocks();
  queries = 0;
  // Throws past a cap, so a loop that never ends fails by name.
  dbMock.dbRead.$queryRaw.mockImplementation((async (sql: Prisma.Sql) => {
    if (++queries > 50) throw new Error('query loop did not end');
    return (await db.query(sql.text, sql.values as unknown[])).rows;
  }) as never);
  // The fixed lookup: every refreshed entry holds the child tag.
  fetch.mockImplementation(async (ids: number[]) =>
    Object.fromEntries(ids.map((id) => [id, { imageId: id, tags: [9001, CHILD] }]))
  );
  await db.exec(`
    TRUNCATE "TagsOnImageDetails", "Image", "Post", "ModelVersion", "Article", "Model3D",
      "Collection", "CollectionItem";
    INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", source, disabled) VALUES
      (1, ${CHILD}, 'Rekognition', false), (1, 9001, 'WD14', false),
      (2, ${CHILD}, 'Rekognition', false), (2, 9001, 'WD14', false),
      (3, ${CHILD}, 'Rekognition', false), (3, 9001, 'WD14', false),
      (10, ${CHILD}, 'Rekognition', false),
      (11, ${CHILD}, 'Rekognition', true), (11, 9001, 'WD14', false),
      (12, ${OTHER}, 'Rekognition', false), (12, 9001, 'WD14', false),
      (13, ${CHILD}, 'WD14', false);
    INSERT INTO "Image" (id, "postId") VALUES (1, 100), (2, 200), (3, NULL), (10, 300), (20, 200);
    INSERT INTO "Post" (id, "modelVersionId") VALUES (100, 1000), (200, NULL), (300, 3000);
    INSERT INTO "ModelVersion" (id, "modelId") VALUES (1000, 50), (3000, 60);
    INSERT INTO "Article" (id, "coverId", "bannerId") VALUES (500, 2, NULL), (501, NULL, 3), (502, 10, NULL);
    INSERT INTO "Model3D" (id, "thumbnailImageId") VALUES (600, 1), (601, 10);
    INSERT INTO "Collection" (id, "imageId") VALUES (70, 1), (71, 10);
    INSERT INTO "CollectionItem" ("collectionId", "imageId", "postId", "modelId", "articleId", "model3dId") VALUES
      (72, 3, NULL, NULL, NULL, NULL),
      (73, NULL, 200, NULL, NULL, NULL),
      (74, 10, NULL, NULL, NULL, NULL),
      (75, NULL, NULL, 50, NULL, NULL),
      (76, NULL, NULL, 60, NULL, NULL),
      (77, NULL, NULL, NULL, 500, NULL),
      (78, NULL, NULL, NULL, 501, NULL),
      (79, NULL, NULL, NULL, 502, NULL),
      (80, NULL, NULL, NULL, NULL, 600),
      (81, NULL, NULL, NULL, NULL, 601);
  `);
});

const refreshedIds = () => refresh.mock.calls.flatMap(([ids]) => ids);
const queuedCollections = () =>
  collectionsQueueUpdate.mock.calls.flatMap(([items]) => items.map((x) => x.id)).sort();

describe('child-label reindex: bust', () => {
  it('refreshes only Rekognition child labels, enabled, on images WD14 also tagged', async () => {
    await runChildLabelReindex({ step: 'bust', dryRun: false, chunkSize: 2 });
    // 10: no WD14. 11: label disabled. 12: not a child tag. 13: child tag from WD14 itself.
    expect(refreshedIds()).toEqual([1, 2, 3]);
    expect(queueModelsReindex).not.toHaveBeenCalled();
    expect(collectionsQueueUpdate).not.toHaveBeenCalled();
  });

  it('refreshes in chunks and reports the entries read back with the child tag', async () => {
    const result = await runChildLabelReindex({ step: 'bust', dryRun: false, chunkSize: 2 });
    expect(refresh.mock.calls).toEqual([[[1, 2]], [[3]]]);
    expect(result).toMatchObject({
      images: 3,
      chunks: 2,
      refreshed: 3,
      verified: 3,
      lastImageId: 3,
    });
  });

  it('resumes above `after` and stops at maxChunks', async () => {
    const result = await runChildLabelReindex({
      step: 'bust',
      dryRun: false,
      chunkSize: 1,
      after: 1,
      maxChunks: 1,
    });
    expect(refreshedIds()).toEqual([2]);
    expect(result).toMatchObject({ images: 2, chunks: 1, lastImageId: 2 });
  });

  it('stops after the first chunk when the refreshed entries still lack the child tag', async () => {
    fetch.mockImplementation(async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { imageId: id, tags: [9001] }]))
    );
    const result = await runChildLabelReindex({ step: 'bust', dryRun: false, chunkSize: 2 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ refreshed: 2, verified: 0, aborted: expect.any(String) });
  });

  it('a dry run counts and refreshes nothing', async () => {
    const result = await runChildLabelReindex({ step: 'bust', dryRun: true, chunkSize: 500 });
    expect(refresh).not.toHaveBeenCalled();
    expect(result).toMatchObject({ images: 3, chunks: 1, refreshed: 0 });
  });
});

describe('child-label reindex: reindex', () => {
  it('queues the models and every collection that can show a selected image', async () => {
    const result = await runChildLabelReindex({ step: 'reindex', dryRun: false, chunkSize: 500 });
    expect(refresh).not.toHaveBeenCalled();
    expect(queueModelsReindex).toHaveBeenCalledWith([50], { dryRun: false, chunkSize: 500 });
    // 70 cover (1); 72 item image (3); 73 item post (200: image 2); 75 item model 50;
    // 77 article cover (2); 78 article banner (3); 80 3D thumbnail (1).
    // Not 71/74/76/79/81: only image 10 or model 60, which are not selected.
    expect(queuedCollections()).toEqual([70, 72, 73, 75, 77, 78, 80]);
    expect(result).toMatchObject({ images: 3, collections: 7, collectionsQueued: 7 });
  });

  it('queues collections in chunks of chunkSize', async () => {
    await runChildLabelReindex({ step: 'reindex', dryRun: false, chunkSize: 4 });
    expect(collectionsQueueUpdate.mock.calls.map(([items]) => items.length)).toEqual([4, 3]);
  });

  it('a dry run counts and queues nothing', async () => {
    const result = await runChildLabelReindex({ step: 'reindex', dryRun: true, chunkSize: 500 });
    expect(collectionsQueueUpdate).not.toHaveBeenCalled();
    expect(queueModelsReindex).toHaveBeenCalledWith([50], { dryRun: true, chunkSize: 500 });
    expect(result).toMatchObject({ collections: 7, collectionsQueued: 0 });
  });
});
