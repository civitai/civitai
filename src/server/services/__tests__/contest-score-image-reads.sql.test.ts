import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  countImageAuthors,
  loadEntryImages,
  loadImagePairs,
  type EntryRow,
  type ResolvedWindow,
} from '../contest-score.queries';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, index int);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int, "userId" int, "publishedAt" timestamp(3));
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int, "userId" int, url text, "nsfwLevel" int NOT NULL,
      "modelRestricted" boolean NOT NULL DEFAULT false, type text NOT NULL DEFAULT 'image', width int, height int,
      index int, ingestion "ImageIngestionStatus" NOT NULL, "blockedFor" text);
    CREATE TABLE "ImageResourceNew" ("imageId" int, "modelVersionId" int);
  `);
});

const PUBLISHED = new Date('2026-01-10T00:00:00Z');

beforeEach(async () => {
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return (await db.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
  await db.exec(`
    TRUNCATE "User", "Model", "ModelVersion", "Post", "Image", "ImageResourceNew";
    INSERT INTO "User" (id) VALUES (1), (2), (3), (4);
    INSERT INTO "Model" VALUES (10, 1);
    INSERT INTO "ModelVersion" VALUES (100, 10, 0);
    INSERT INTO "Post" VALUES (1000, 100, 1, '${PUBLISHED.toISOString()}');
    INSERT INTO "Image" (id, "postId", "userId", url, "nsfwLevel", index, ingestion, "blockedFor") VALUES
      (1, 1000, 2, 'u1', 32, 0, 'Rescan', 'moderated'),
      (2, 1000, 3, 'u2', 1, 1, 'Rescan', 'AiNotVerified'),
      (3, 1000, 4, 'u3', 1, 2, 'Scanned', NULL);
    INSERT INTO "ImageResourceNew" VALUES (1, 100), (2, 100), (3, 100);
  `);
});

const entry = { collectionItemId: 7, modelId: 10, creatorId: 1, addedById: 1 } as EntryRow;
const window = {
  start: new Date('2026-01-01T00:00:00Z'),
  effectiveEnd: new Date('2026-02-01T00:00:00Z'),
} as ResolvedWindow;

// civitai/civitai#10097: contest reads skip an image that carries a block marker.
describe('contest image reads', () => {
  it('the entry image skips images with a block reason', async () => {
    const images = await loadEntryImages([10]);
    expect(images.get(10)?.id).toBe(3);
  });

  it('image pairs skip images with a block reason', async () => {
    const rows = await loadImagePairs([entry], [{ entryId: 7, entityId: 100 } as never], window);
    expect(rows.map((r) => Number(r.imageId))).toEqual([3]);
  });

  it('image authors are counted without images with a block reason', async () => {
    const [row] = await countImageAuthors(
      [entry],
      [{ entryId: 7, entityId: 100 } as never],
      window,
      { baseDisqualifiedIds: [], userIdThreshold: 1_000_000 } as never
    );
    expect(row.rawUsers).toBe(1);
  });
});
