import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The version showcase query, run against PGlite: an image a moderator marked as a TOS violation
 * stays out of the showcase, while the clean image beside it in the same post is still served.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { getImagesForModelVersion } = await import('../image.service');

const OWNER = 10;
const VERSION = 100;
const POST = 1000;
const PG = 1;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "TextScanHold" ("entityType" text, "entityId" int, label text, status text);
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int,
      "publishedAt" timestamp, availability text NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, index int NOT NULL DEFAULT 0,
      name text, url text NOT NULL DEFAULT '', "nsfwLevel" int NOT NULL, width int, height int,
      hash text, type "MediaType" NOT NULL DEFAULT 'image', metadata jsonb, meta jsonb,
      "hideMeta" boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false, "blockedFor" text, "needsReview" text,
      "acceptableMinor" boolean NOT NULL DEFAULT false,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "scanJobs" jsonb,
      "modelRestricted" boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false
    );
    INSERT INTO "Model" VALUES (1, ${OWNER});
    INSERT INTO "ModelVersion" VALUES (${VERSION}, 1);
    INSERT INTO "Post" VALUES (${POST}, ${OWNER}, ${VERSION}, now(), 'Public');
  `);
  // Integers typed as Prisma sends them: untyped, `unnest(ARRAY[$1])` would come back as text.
  const INT4_OID = 23;
  dbMock.dbRead.$queryRaw.mockImplementation((async (sql: Prisma.Sql) => {
    const paramTypes = sql.values.map((v) => (Number.isInteger(v) ? INT4_OID : 0));
    return (await db.query(sql.text, sql.values, { paramTypes })).rows;
  }) as never);
});
afterAll(() => db.close());

beforeEach(async () => {
  await db.exec(`DELETE FROM "Image";`);
});

async function image(id: number, index: number, tosViolation: boolean) {
  await db.query(
    `INSERT INTO "Image" (id, "userId", "postId", index, "nsfwLevel", "tosViolation")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, OWNER, POST, index, PG, tosViolation]
  );
}

describe('getImagesForModelVersion: tosViolation', () => {
  it('drops a TOS-violation image and keeps the clean one in the same post', async () => {
    await image(1, 0, true);
    await image(2, 1, false);

    const images = await getImagesForModelVersion({
      modelVersionIds: [VERSION],
      imagesPerVersion: 20,
    });

    expect(images.map((i) => i.id)).toEqual([2]);
  });
});
