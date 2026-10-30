import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * Runs `getEntityCoverImage`'s real query against an in-process Postgres. An Article draws a row
 * from its own branch (the cover) and one from CONNECTIONS (a content image), and which one the
 * service keeps is decided by the order Postgres returns them in, which a mocked query cannot show.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/cosmetic.service', () => ({
  getCosmeticsForEntity: vi.fn().mockResolvedValue({}),
  getEventDecorationsForEntity: vi.fn().mockResolvedValue({}),
}));

import { getEntityCoverImage } from '../image.service';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, name text, url text, "nsfwLevel" int DEFAULT 1, width int, height int,
      hash text, "hideMeta" boolean DEFAULT false, meta jsonb, "createdAt" timestamp DEFAULT now(),
      "mimeType" text, type text DEFAULT 'image', metadata jsonb, "scannedAt" timestamp,
      "needsReview" text, "userId" int DEFAULT 1, index int DEFAULT 0, "postId" int,
      poi boolean, minor boolean, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "modelRestricted" boolean DEFAULT false, "nsfwLevelLocked" boolean DEFAULT false,
      "scanJobs" jsonb
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "publishedAt" timestamp, "userId" int DEFAULT 1,
      status text DEFAULT 'Published', ingestion text DEFAULT 'Scanned'
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int, status text, availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int, index int, status text, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int, "modelVersionId" int, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "Bounty" (
      id int PRIMARY KEY, "userId" int DEFAULT 1, availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL);
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

beforeEach(async () => {
  await db.exec(`TRUNCATE "Image", "Article", "ImageConnection", "Bounty", "Post";`);
});

const coverOf = async (entityId: number, entityType = 'Article') => {
  const [cover, ...rest] = await getEntityCoverImage({ entities: [{ entityId, entityType }] });
  expect(rest).toHaveLength(0);
  return cover?.id ?? null;
};

describe('getEntityCoverImage, an Article with content images', () => {
  it('serves the cover even when a content image has a lower id', async () => {
    // The content image was uploaded before the cover was chosen, so its id is lower.
    await db.exec(`
      INSERT INTO "Image" (id, url) VALUES (10, 'content'), (20, 'cover');
      INSERT INTO "Article" VALUES (1, 20, now());
      INSERT INTO "ImageConnection" VALUES (10, 1, 'Article');
    `);
    expect(await coverOf(1)).toBe(20);
  });

  it('serves the cover when it has the lower id', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url) VALUES (20, 'cover'), (30, 'content');
      INSERT INTO "Article" VALUES (1, 20, now());
      INSERT INTO "ImageConnection" VALUES (30, 1, 'Article');
    `);
    expect(await coverOf(1)).toBe(20);
  });

  it('falls back to a content image when the cover is not scanned or awaits review', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, ingestion, "needsReview") VALUES
        (20, 'pending cover', 'Pending', null), (21, 'flagged cover', 'Scanned', 'minor'),
        (30, 'content a', 'Scanned', null), (31, 'content b', 'Scanned', null);
      INSERT INTO "Article" VALUES (1, 20, now()), (2, 21, now());
      INSERT INTO "ImageConnection" VALUES (30, 1, 'Article'), (31, 2, 'Article');
    `);
    expect(await coverOf(1)).toBe(30);
    expect(await coverOf(2)).toBe(31);
  });

  it('keeps a bounty on its lowest connected image', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url) VALUES (40, 'a'), (50, 'b');
      INSERT INTO "Bounty" (id) VALUES (7);
      INSERT INTO "ImageConnection" VALUES (50, 7, 'Bounty'), (40, 7, 'Bounty');
    `);
    expect(await coverOf(7, 'Bounty')).toBe(40);
  });

  it('keeps each entity in a mixed batch on its own cover', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, "postId") VALUES
        (10, 'content', null), (20, 'cover', null), (40, 'bounty', null), (60, 'image', 2);
      INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (2, 1, now() - interval '1 day');
      INSERT INTO "Bounty" (id) VALUES (1);
      INSERT INTO "Article" VALUES (1, 20, now());
      INSERT INTO "ImageConnection" VALUES (10, 1, 'Article'), (40, 1, 'Bounty');
    `);
    const covers = await getEntityCoverImage({
      entities: [
        { entityId: 1, entityType: 'Bounty' },
        { entityId: 1, entityType: 'Article' },
        { entityId: 60, entityType: 'Image' },
      ],
    });
    expect(covers.map((c) => [c.entityType, c.entityId, c.id])).toEqual([
      ['Bounty', 1, 40],
      ['Article', 1, 20],
      ['Image', 60, 60],
    ]);
  });
});
