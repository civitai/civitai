import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { Prisma } from '@prisma/client';

/**
 * The child-label reindex route's work, with its SQL run on an in-memory Postgres: which images it
 * selects, that a dry run writes nothing, and that a real run refreshes exactly the selected
 * images' cached tag ids and queues the models and collections holding them.
 */

const { refresh, queueModelsReindex, collectionsQueueUpdate } = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
  queueModelsReindex: vi.fn(async (ids: number[], opts: { dryRun: boolean }) => ({
    dryRun: opts.dryRun,
    modelCount: ids.length,
  })),
  collectionsQueueUpdate: vi.fn(async () => undefined),
}));
vi.mock('~/server/redis/caches', () => ({ tagIdsForImagesCache: { refresh } }));
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
    CREATE TYPE "TagSource" AS ENUM ('User', 'Rekognition', 'WD14', 'Computed', 'ImageHash', 'Hive', 'MinorDetection', 'HiveDemographics', 'Clavata');
    CREATE TABLE "TagsOnImageDetails" (
      "imageId" int NOT NULL, "tagId" int NOT NULL, source "TagSource" NOT NULL,
      disabled boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Collection" (id int PRIMARY KEY, "imageId" int);
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int NOT NULL, "imageId" int, "postId" int
    );
  `);
  dbMock.dbRead.$queryRaw.mockImplementation(
    (async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values as unknown[])).rows) as never
  );
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`
    TRUNCATE "TagsOnImageDetails", "Image", "Post", "ModelVersion", "Collection", "CollectionItem";
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
    INSERT INTO "Collection" (id, "imageId") VALUES (70, 1), (71, 10);
    INSERT INTO "CollectionItem" ("collectionId", "imageId", "postId") VALUES
      (72, 3, NULL), (73, NULL, 200), (74, 10, NULL);
  `);
});

const refreshedIds = () => (refresh.mock.calls as unknown as [number[]][]).flatMap(([ids]) => ids);

describe('child-label reindex', () => {
  it('selects only Rekognition child labels, enabled, on images WD14 also tagged', async () => {
    await runChildLabelReindex({ step: 'bust', dryRun: false, chunkSize: 2 });
    // 10: no WD14. 11: label disabled. 12: not a child tag. 13: child tag from WD14 itself.
    expect(refreshedIds()).toEqual([1, 2, 3]);
  });

  it('reads the selection in keyset chunks of chunkSize', async () => {
    const result = await runChildLabelReindex({ step: 'bust', dryRun: false, chunkSize: 2 });
    expect(refresh.mock.calls).toEqual([[[1, 2]], [[3]]]);
    expect(result).toMatchObject({ images: 3, chunks: 2, refreshed: 3 });
  });

  it('a dry-run bust counts and refreshes nothing', async () => {
    const result = await runChildLabelReindex({ step: 'bust', dryRun: true, chunkSize: 500 });
    expect(refresh).not.toHaveBeenCalled();
    expect(result).toMatchObject({ images: 3, chunks: 1, refreshed: 0 });
  });

  it('queues the models and collections that hold a selected image', async () => {
    const result = await runChildLabelReindex({ step: 'reindex', dryRun: false, chunkSize: 500 });
    expect(refresh).not.toHaveBeenCalled();
    expect(queueModelsReindex).toHaveBeenCalledWith([50], { dryRun: false, chunkSize: 500 });
    const queued = (collectionsQueueUpdate.mock.calls as unknown as [{ id: number }[]][])
      .flatMap(([items]) => items.map((x) => x.id))
      .sort();
    // 70: cover image 1. 72: item image 3. 73: item post 200 (image 2). Not 71/74 (image 10).
    expect(queued).toEqual([70, 72, 73]);
    expect(result).toMatchObject({ images: 3, collections: 3, collectionsQueued: 3 });
  });

  it('a dry-run reindex counts and queues nothing', async () => {
    const result = await runChildLabelReindex({ step: 'reindex', dryRun: true, chunkSize: 500 });
    expect(collectionsQueueUpdate).not.toHaveBeenCalled();
    expect(queueModelsReindex).toHaveBeenCalledWith([50], { dryRun: true, chunkSize: 500 });
    expect(result).toMatchObject({ collections: 3, collectionsQueued: 0 });
  });
});
