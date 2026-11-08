import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as UserService from '~/server/services/user.service';

/**
 * `image.getResources` against an in-process Postgres: an image's resources follow the same
 * by-id visibility as `image.get`, and a body only the owner or a moderator may read never
 * reaches the shared edge cache.
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
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn().mockResolvedValue(false),
}));

import { getImageResourcesHandler } from '~/server/controllers/image.controller';

const OWNER = 10;
const viewers = {
  anonymous: undefined,
  stranger: { id: 20 },
  owner: { id: OWNER },
  moderator: { id: 30, isModerator: true },
};
type Who = keyof typeof viewers;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT ${OWNER}, "postId" int, "nsfwLevel" int DEFAULT 1,
      "needsReview" text, "blockedFor" text, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}',
      "scanJobs" jsonb, "acceptableMinor" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT ${OWNER}, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, status text, "publishedAt" timestamp, ingestion text,
      "bannerId" int
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Bounty" (
      id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "Model" (id int PRIMARY KEY, status text, "sfwName" text);
    CREATE TABLE "ImageResourceHelper" (
      "imageId" int, "reviewId" int, "reviewRating" int, "reviewDetails" text,
      "reviewCreatedAt" timestamp, name text, "modelVersionId" int, "modelVersionName" text,
      "modelVersionCreatedAt" timestamp, "modelId" int, "modelName" text,
      "modelThumbsUpCount" int, "modelThumbsDownCount" int, "modelDownloadCount" int,
      "modelCommentCount" int, "modelType" text, "modelVersionBaseModel" text, detected boolean
    );

    INSERT INTO "Post" (id, "publishedAt", availability) VALUES
      (1, now() - interval '1 day', 'Public'), (2, now() - interval '1 day', 'Private');
    -- 101 clean; 102 flagged; 103 blocked; 104 on a Private post.
    INSERT INTO "Image" (id, "postId", "acceptableMinor", "blockedFor") VALUES
      (101, 1, false, null), (102, 1, true, null), (103, 1, false, 'tos'), (104, 2, false, null);
    INSERT INTO "Model" (id, status) VALUES (1, 'Published');
    -- 105 is clean, on a model with a .com face name.
    INSERT INTO "Image" (id, "postId") VALUES (105, 1);
    INSERT INTO "Model" (id, status, "sfwName") VALUES (2, 'Published', 'Safe name');
    INSERT INTO "ImageResourceHelper" ("imageId", "modelVersionId", "modelId", "modelName") VALUES
      (105, 12, 2, 'm');
    INSERT INTO "ImageResourceHelper" ("imageId", "modelVersionId", "modelId", "modelName") VALUES
      (101, 11, 1, 'm'), (102, 11, 1, 'm'), (103, 11, 1, 'm'), (104, 11, 1, 'm');
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

const call = async (id: number, who: Who) => {
  const cache = { canCache: true, skip: false };
  const ctx = { user: viewers[who], features: { canViewNsfw: true }, cache };
  const resources = await getImageResourcesHandler({ input: { id }, ctx: ctx as never });
  return { versionIds: resources.map((r) => r.modelVersionId), skip: cache.skip };
};

const hidden: [string, number][] = [
  ['a flagged image', 102],
  ['a blocked image', 103],
  ['an image on a Private post', 104],
];

describe('image.getResources follows by-id image visibility', () => {
  describe.each(hidden)('%s', (_, id) => {
    it.each(['anonymous', 'stranger'] as const)('is not found for a %s viewer', async (who) => {
      await expect(call(id, who)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
    it.each(['owner', 'moderator'] as const)(
      'returns its resources to the %s, kept out of the edge cache',
      async (who) => {
        expect(await call(id, who)).toEqual({ versionIds: [11], skip: true });
      }
    );
  });

  it.each(Object.keys(viewers) as Who[])(
    'returns a clean image’s resources to a %s viewer, edge-cacheable',
    async (who) => {
      expect(await call(101, who)).toEqual({ versionIds: [11], skip: false });
    }
  );

  it('keeps a clean image out of the edge cache when a resource name depends on the viewer', async () => {
    expect(await call(105, 'anonymous')).toEqual({ versionIds: [12], skip: true });
    // Control: the same clean read without a .com face name stays cacheable.
    expect(await call(101, 'anonymous')).toEqual({ versionIds: [11], skip: false });
  });
});
