import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import type * as UserPreferences from '~/server/services/user-preferences.service';

/**
 * `getImageIdsVisibleToViewer` against two in-process Postgres databases: `replica` behind
 * dbRead and `primary` behind dbWrite, so a row written moments ago can exist on one only.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { getCached } = vi.hoisted(() => ({
  getCached: vi.fn(async (..._a: unknown[]): Promise<{ id: number; username: string }[]> => []),
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const actual = await importOriginal<typeof UserPreferences>();
  return { ...actual, BlockedByUsers: { ...actual.BlockedByUsers, getCached } };
});

import {
  assertImagesVisibleToViewer,
  getImageIdsVisibleToViewer,
} from '~/server/services/image-visibility.service';

const OWNER = 10;
const VIEWER = 20;
const OPTED_OUT_OWNER = 30;

const SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
  CREATE TABLE "Image" (
    minor boolean DEFAULT false,
    id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int DEFAULT 1,
    "needsReview" text, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
    "nsfwLevelLocked" boolean DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}', "scanJobs" jsonb
  );
  CREATE TABLE "Post" (
    id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
    availability "Availability" DEFAULT 'Public', "collectionId" int
  );
  CREATE TABLE "Article" (
    id int PRIMARY KEY, "coverId" int, status text, "publishedAt" timestamp, ingestion text
  );
  CREATE TABLE "CollectionContributor" (
    "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
  );
  CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public');
  CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
  CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
`;

let replica: PGlite;
let primary: PGlite;

beforeAll(async () => {
  replica = new PGlite();
  primary = new PGlite();
  await Promise.all([replica.exec(SCHEMA), primary.exec(SCHEMA)]);
  const replicaRaw = pgliteRaw(replica);
  const primaryRaw = pgliteRaw(primary);
  dbMock.dbRead.$queryRaw.mockImplementation(((s: TemplateStringsArray, ...v: unknown[]) =>
    replicaRaw.queryRaw(s, ...v)) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(((s: TemplateStringsArray, ...v: unknown[]) =>
    primaryRaw.queryRaw(s, ...v)) as never);
});

afterAll(async () => {
  await Promise.all([replica.close(), primary.close()]);
});

beforeEach(async () => {
  const reset = `TRUNCATE "Image", "Post";
    INSERT INTO "Post" (id, "userId", "publishedAt", availability) VALUES
      (1, ${OWNER}, now() - interval '1 day', 'Public'),
      (2, ${OWNER}, now() - interval '1 day', 'Private'),
      (3, ${OWNER}, NULL, 'Public'),
      (4, ${OPTED_OUT_OWNER}, now() - interval '1 day', 'Public');
    INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel", ingestion) VALUES
      (101, ${OWNER}, 1, 1, 'Scanned'),
      (102, ${OWNER}, 2, 1, 'Scanned'),
      (103, ${OWNER}, 3, 1, 'Scanned'),
      (104, ${OWNER}, 1, ${NsfwLevel.Blocked}, 'Scanned'),
      (105, ${OWNER}, 1, 1, 'Pending'),
      (106, ${OWNER}, NULL, 1, 'Scanned'),
      (107, ${OPTED_OUT_OWNER}, 4, 1, 'Scanned');`;
  await Promise.all([replica.exec(reset), primary.exec(reset)]);
  getCached.mockReset().mockResolvedValue([]);
});

const ALL = [101, 102, 103, 104, 105, 106, 107];

describe('getImageIdsVisibleToViewer', () => {
  it('returns only the images a stranger could open', async () => {
    const visible = await getImageIdsVisibleToViewer({ ids: [...ALL, 999], userId: VIEWER });
    // Private post, unpublished post, removed-level rating, unscanned, postless upload and a
    // nonexistent id are all refused; the public scanned image and the other public one pass.
    expect([...visible].sort()).toEqual([101, 107]);
  });

  it('lets the owner see their own images in every state', async () => {
    const visible = await getImageIdsVisibleToViewer({ ids: ALL, userId: OWNER });
    expect([...visible].sort()).toEqual(ALL);
  });

  it('lets staff see every image that exists', async () => {
    const visible = await getImageIdsVisibleToViewer({
      ids: [...ALL, 999],
      userId: VIEWER,
      isModerator: true,
    });
    expect([...visible].sort()).toEqual(ALL);
  });

  it("refuses an image from an owner who opted out of this viewer, but not the viewer's own", async () => {
    getCached.mockResolvedValue([{ id: OPTED_OUT_OWNER, username: 'owner' }]);
    expect([...(await getImageIdsVisibleToViewer({ ids: [101, 107], userId: VIEWER }))]).toEqual([
      101,
    ]);
    expect(
      [...(await getImageIdsVisibleToViewer({ ids: [107], userId: OPTED_OUT_OWNER }))].sort()
    ).toEqual([107]);
  });

  it('counts an image whose post the replica still shows as a draft', async () => {
    // Published moments ago: only the primary has the publish.
    await replica.exec(`UPDATE "Post" SET "publishedAt" = NULL WHERE id = 1;`);
    expect([...(await getImageIdsVisibleToViewer({ ids: [101], userId: VIEWER }))]).toEqual([101]);
  });

  it('applies the same rule to an image read from the primary', async () => {
    await primary.exec(
      `INSERT INTO "Image" (id, "userId", "postId", ingestion) VALUES (109, ${OWNER}, 2, 'Scanned');`
    );
    expect([...(await getImageIdsVisibleToViewer({ ids: [109], userId: VIEWER }))]).toEqual([]);
  });

  it('finds an image the replica has not caught up on, from the primary', async () => {
    await primary.exec(
      `INSERT INTO "Image" (id, "userId", "postId", ingestion) VALUES (108, ${VIEWER}, NULL, 'Pending');`
    );
    const visible = await getImageIdsVisibleToViewer({ ids: [101, 108], userId: VIEWER });
    expect([...visible].sort()).toEqual([101, 108]);
  });
});

describe('assertImagesVisibleToViewer', () => {
  it('throws NOT_FOUND when any id is not visible', async () => {
    await expect(
      assertImagesVisibleToViewer({ ids: [101, 102], userId: VIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('resolves when every id is visible', async () => {
    await expect(
      assertImagesVisibleToViewer({ ids: [101, 107], userId: VIEWER })
    ).resolves.toBeUndefined();
  });
});
