import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * Runs `getEntityCoverImage`'s real query against an in-process Postgres: a cover respects the
 * parent entity's visibility, the same rule that entity's own page applies, with the owner and
 * moderators still seeing it.
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

const OWNER = 10;
const viewers = {
  anonymous: undefined,
  stranger: { id: 20 },
  owner: { id: OWNER },
  moderator: { id: 30, isModerator: true },
};

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
      "needsReview" text, "userId" int DEFAULT ${OWNER}, index int DEFAULT 0, "postId" int,
      poi boolean, minor boolean, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "modelRestricted" boolean DEFAULT false, "nsfwLevelLocked" boolean DEFAULT false,
      "scanJobs" jsonb
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int DEFAULT ${OWNER}, "modelVersionId" int,
      "publishedAt" timestamp, availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "userId" int DEFAULT ${OWNER}, status text,
      "publishedAt" timestamp, ingestion text DEFAULT 'Scanned'
    );
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int DEFAULT ${OWNER}, status text,
      availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int, index int DEFAULT 0, status text, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "Bounty" (
      id int PRIMARY KEY, "userId" int DEFAULT ${OWNER}, availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );

    -- Bounty 1 is Private, bounty 2 Public. Entry 3 sits on bounty 1, entry 4 on bounty 2.
    INSERT INTO "Bounty" VALUES (1, ${OWNER}, 'Private'), (2, ${OWNER}, 'Public');
    INSERT INTO "BountyEntry" VALUES (3, 1, 50), (4, 2, 50);
    INSERT INTO "Image" (id) VALUES (101), (102), (103), (104);
    INSERT INTO "ImageConnection" VALUES
      (101, 1, 'Bounty'), (102, 2, 'Bounty'), (103, 3, 'BountyEntry'), (104, 4, 'BountyEntry');

    -- Posts: 201 published, 202 scheduled, 203 draft, 204 Private.
    INSERT INTO "Post" (id, "publishedAt", availability) VALUES
      (201, now() - interval '1 day', 'Public'), (202, now() + interval '1 day', 'Public'),
      (203, null, 'Public'), (204, now() - interval '1 day', 'Private');
    INSERT INTO "Image" (id, "postId") VALUES (211, 201), (212, 202), (213, 203), (214, 204);
    -- A postless upload that is no article cover and on no bounty.
    INSERT INTO "Image" (id) VALUES (215);

    -- Articles: 301 published, 302 draft, 303 draft with content images only.
    INSERT INTO "Image" (id) VALUES (311), (312), (313);
    INSERT INTO "Article" (id, "coverId", status, "publishedAt") VALUES
      (301, 311, 'Published', now()), (302, 312, 'Draft', null), (303, null, 'Draft', null);
    INSERT INTO "ImageConnection" VALUES (313, 303, 'Article');

    -- Models: 401 public, 402 Private, 403 draft. One version and owner post each.
    INSERT INTO "Model" (id, status, availability) VALUES
      (401, 'Published', 'Public'), (402, 'Published', 'Private'), (403, 'Draft', 'Public');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES
      (411, 401, 'Published'), (412, 402, 'Published'), (413, 403, 'Published');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt") VALUES
      (421, 411, now()), (422, 412, now()), (423, 413, now());
    INSERT INTO "Image" (id, "postId") VALUES (431, 421), (432, 422), (433, 423);

    -- Versions on public model 401: 511 Private, 512 scheduled, 513 draft.
    INSERT INTO "ModelVersion" (id, "modelId", status, "publishedAt", availability) VALUES
      (511, 401, 'Published', null, 'Private'),
      (512, 401, 'Scheduled', now() + interval '1 day', 'Public'),
      (513, 401, 'Draft', null, 'Public');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt") VALUES
      (521, 511, now()), (522, 512, now()), (523, 513, now());
    INSERT INTO "Image" (id, "postId") VALUES (531, 521), (532, 522), (533, 523);
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

type Viewer = (typeof viewers)[keyof typeof viewers];
const coverOf = async (entityType: string, entityId: number, viewer: Viewer) => {
  const covers = await getEntityCoverImage({ entities: [{ entityType, entityId }], viewer });
  return covers[0]?.id ?? null;
};

const hidden: [string, string, number, number][] = [
  ['a Private bounty', 'Bounty', 1, 101],
  ['an entry on a Private bounty', 'BountyEntry', 3, 103],
  ['an image on a scheduled post', 'Image', 212, 212],
  ['an image on a draft post', 'Image', 213, 213],
  ['an image on a Private post', 'Image', 214, 214],
  ['an image with no post', 'Image', 215, 215],
  ['a scheduled post', 'Post', 202, 212],
  ['a draft post', 'Post', 203, 213],
  ['a Private post', 'Post', 204, 214],
  ['a draft article', 'Article', 302, 312],
  ['a draft article with content images only', 'Article', 303, 313],
  ['a Private model', 'Model', 402, 432],
  ['a draft model', 'Model', 403, 433],
  ['a version of a Private model', 'ModelVersion', 412, 432],
  ['a version of a draft model', 'ModelVersion', 413, 433],
  ['a Private version', 'ModelVersion', 511, 531],
  ['a scheduled version', 'ModelVersion', 512, 532],
  ['a draft version', 'ModelVersion', 513, 533],
];

const visible: [string, string, number, number][] = [
  ['a public bounty', 'Bounty', 2, 102],
  ['an entry on a public bounty', 'BountyEntry', 4, 104],
  ['an image on a published post', 'Image', 211, 211],
  ['a published post', 'Post', 201, 211],
  ['a published article', 'Article', 301, 311],
  ['a public model', 'Model', 401, 431],
  ['a published version of a public model', 'ModelVersion', 411, 431],
];

describe('getEntityCoverImage respects the parent entity visibility', () => {
  describe.each(hidden)('%s', (_, entityType, entityId, imageId) => {
    it.each(['anonymous', 'stranger'] as const)('has no cover for a %s viewer', async (who) => {
      expect(await coverOf(entityType, entityId, viewers[who])).toBeNull();
    });
    it.each(['owner', 'moderator'] as const)('keeps its cover for the %s', async (who) => {
      expect(await coverOf(entityType, entityId, viewers[who])).toBe(imageId);
    });
  });

  describe.each(visible)('%s', (_, entityType, entityId, imageId) => {
    it.each(['anonymous', 'stranger'] as const)('keeps its cover for a %s viewer', async (who) => {
      expect(await coverOf(entityType, entityId, viewers[who])).toBe(imageId);
    });
  });

  it('treats a missing viewer as anonymous', async () => {
    const covers = await getEntityCoverImage({
      entities: [
        { entityType: 'Bounty', entityId: 1 },
        { entityType: 'Bounty', entityId: 2 },
      ],
    } as Parameters<typeof getEntityCoverImage>[0]);
    expect(covers.map((c) => c.id)).toEqual([102]);
  });
});
