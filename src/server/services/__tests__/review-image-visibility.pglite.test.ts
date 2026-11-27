import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * A postless image a buyer attached to a service review opens by id only through the image page's
 * opt-in (`shownReviewImageLevels`), and only while the offering page would show it to this viewer.
 * Every other by-id reader leaves the opt-in off and keeps the image owner-only. Run against an
 * in-process Postgres, so each state is decided by the real predicate.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// assertImageVisibleToViewer reads through Kysely; its statements get this file's `$queryRaw` answers.
vi.mock('~/server/db/kyselyDb.lazy', async () => {
  const { fakeKyselyDbLazy, answerLike } = await import('~/test-utils/kysely-raw-fake');
  const { dbMock } = await import('~/__tests__/mocks/db.mock');
  return fakeKyselyDbLazy(
    answerLike(dbMock.dbRead.$queryRaw),
    answerLike(dbMock.dbWrite.$queryRaw)
  );
});

import {
  assertImageReportable,
  assertImageVisibleToViewer,
  getImageIdsVisibleToViewer,
  imageVisibilityConditions,
} from '~/server/services/image-visibility.service';
import { reviewOfImageSql } from '~/server/services/creator-service-review-image-sql';
import { getOwnRetractedMedia } from '~/server/services/retracted-media.service';
import { BlockedByUsers, BlockedUsers } from '~/server/services/user-preferences.service';
import { shownReviewImageLevelsFor } from '~/server/utils/review-image-levels';
import { childSafetyCaseTablesSql } from '~/server/services/__tests__/child-safety-case-tables';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

const SELLER = 990000001;
const BUYER = 990000002;
const OTHER = 990000003;
const IMAGE = 990000010;
const UNRELATED = 990000011;
const R = 4;
const X = 8;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TYPE "ServiceOfferingStatus" AS ENUM ('Draft', 'Active', 'Paused', 'Removed');
    CREATE TABLE "User" (
      id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp, username text, image text,
      "profilePictureId" int, muted boolean NOT NULL DEFAULT false, settings jsonb DEFAULT '{}'
    );
    CREATE TABLE "ServiceDealFileEntry" (id serial PRIMARY KEY, "fileId" int, "imageId" int);
    CREATE TABLE "ServiceDealFile" (id serial PRIMARY KEY, "imageId" int);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb NOT NULL DEFAULT '[]',
      details jsonb NOT NULL DEFAULT '{}', "reportSentAt" timestamp, "archivedAt" timestamp);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int DEFAULT 1,
      "needsReview" text, "blockedFor" text, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}', "scanJobs" jsonb,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "modelRestricted" boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false,
      -- The rest of what the image page reads.
      name text, url text, height int, width int, index int, hash text, "hideMeta" boolean DEFAULT false,
      "createdAt" timestamp DEFAULT now(), "mimeType" text, "scannedAt" timestamp, type text, meta jsonb,
      "firstVisibleAt" timestamp
    );
    CREATE TABLE "ImageReaction" ("imageId" int, "userId" int, reaction text);
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public', "collectionId" int, "modelVersionId" int,
      "model3dId" int
    );
    CREATE TABLE "Model3D" (id int PRIMARY KEY, "userId" int, status text, "deletedAt" timestamp);
    CREATE TABLE "Model" (
      id int PRIMARY KEY, mode text, minor boolean, "sfwOnly" boolean, "gallerySettings" jsonb
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, status text, "publishedAt" timestamp, ingestion text,
      "bannerId" int, availability "Availability" DEFAULT 'Public', "userId" int
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public');
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
    CREATE TABLE "Crucible" (id int PRIMARY KEY, status "CrucibleStatus", "endAt" timestamp, "nsfwLevel" int);
    CREATE TABLE "CrucibleEntry" (id int PRIMARY KEY, "crucibleId" int, "userId" int, "imageId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "ServiceOffering" (
      id int PRIMARY KEY, "sellerId" int NOT NULL, "allowReviewWork" boolean NOT NULL DEFAULT true,
      status "ServiceOfferingStatus" NOT NULL DEFAULT 'Active'
    );
    CREATE TABLE "ServiceDeal" (
      id int PRIMARY KEY, "offeringId" int NOT NULL, "sellerId" int NOT NULL, "buyerId" int NOT NULL,
      "maxNsfwLevel" int NOT NULL DEFAULT 1
    );
    CREATE TABLE "ServiceDealReview" (
      id int PRIMARY KEY, "dealId" int NOT NULL, "buyerId" int NOT NULL, "sellerId" int NOT NULL,
      "publishedAt" timestamp, "hiddenAt" timestamp
    );
    CREATE TABLE "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL UNIQUE, "sourceFileId" int);
    CREATE TABLE "Report" (id serial PRIMARY KEY, status text NOT NULL DEFAULT 'Pending');
  `);
  await db.exec(childSafetyCaseTablesSql);
  const triggers = readFileSync(
    path.resolve(
      __dirname,
      '../../../../packages/civitai-db-schema/prisma/programmability/image_post_triggers.sql'
    ),
    'utf8'
  );
  await db.exec(triggers.match(/CREATE OR REPLACE FUNCTION image_sort_at\([\s\S]*?\$\$;/)![0]);
  const raw = pgliteRaw(db);
  const answer = async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
    Array.isArray(first)
      ? raw.queryRaw(first as TemplateStringsArray, ...values)
      : (await db.query((first as Prisma.Sql).text, (first as Prisma.Sql).values)).rows;
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(answer);
  (dbMock.dbWrite.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(answer);
});

// What the owner CSAM check (`ownerCsamMarkedSql`) reads, beyond this file's tables.
const CSAM_CHECK_TABLES = `
  ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "pHash" bigint;
  CREATE TABLE IF NOT EXISTS "BlockedImage" (hash bigint, reason text);
  CREATE TABLE IF NOT EXISTS "ScanLabelItem" (id int PRIMARY KEY, "imageId" int, "voidReason" text);
  CREATE TABLE IF NOT EXISTS "ScanLabelFlag" ("itemId" int, snapshot jsonb);
  CREATE TABLE IF NOT EXISTS "ScanLabelVote" ("itemId" int, reason text);
  CREATE TABLE IF NOT EXISTS "ImageCdnModeratorDelete" ("imageId" int, url text, "userId" int, "csamReview" boolean);
`;

let blocks: Array<[number, number]> = [];

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "User", "Image", "Post", "Article", "CollectionContributor", "Bounty", "BountyEntry",
      "ImageConnection", "ServiceOffering", "ServiceDeal", "ServiceDealReview", "ServiceDealReviewImage",
      "ServiceDealFile", "ServiceDealFileEntry";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER}), (${OTHER});
    UPDATE "User" SET settings = '{"creatorShop":{"enabled":true}}' WHERE id = ${SELLER};
    INSERT INTO "ServiceOffering" (id, "sellerId") VALUES (1, ${SELLER});
    INSERT INTO "ServiceDeal" (id, "offeringId", "sellerId", "buyerId", "maxNsfwLevel")
      VALUES (1, 1, ${SELLER}, ${BUYER}, ${R});
    INSERT INTO "ServiceDealReview" (id, "dealId", "buyerId", "sellerId", "publishedAt")
      VALUES (1, 1, ${BUYER}, ${SELLER}, now());
    INSERT INTO "Image" (id, "userId") VALUES (${IMAGE}, ${BUYER}), (${UNRELATED}, ${BUYER});
    INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId") VALUES (1, ${IMAGE});
  `);
  // [blocker, blocked]
  blocks = [];
  vi.spyOn(BlockedUsers, 'getCached').mockImplementation(async ({ userId }) =>
    blocks.filter(([by]) => by === userId).map(([, id]) => ({ id } as never))
  );
  vi.spyOn(BlockedByUsers, 'getCached').mockImplementation(async ({ userId }) =>
    blocks.filter(([, id]) => id === userId).map(([by]) => ({ id: by } as never))
  );
});

type Viewer = { userId?: number; isModerator?: boolean };
const ANON: Viewer = {};
const STRANGER: Viewer = { userId: OTHER };
const MOD: Viewer = { userId: OTHER, isModerator: true };

/** Whether `viewer` may open `id` through `imageVisibilityConditions`, opted in at `levels` or not. */
async function opens(viewer: Viewer, levels: number | undefined, id = IMAGE) {
  const where = Prisma.join(
    [
      Prisma.sql`i.id = ${id}`,
      ...imageVisibilityConditions({ ...viewer, shownReviewImageLevels: levels }),
    ],
    ' AND '
  );
  const rows = await pgliteRaw(db)
    .queryRaw`SELECT i.id FROM "Image" i LEFT JOIN "Post" p ON p.id = i."postId" WHERE ${where}`;
  return rows.length === 1;
}

// The offering page's own rule: Active, a seller in good standing, a shop that is on.
const OFFERING_NOT_VIEWABLE: Array<[string, string]> = [
  ['the offering is removed', `UPDATE "ServiceOffering" SET status = 'Removed'`],
  ['the seller is banned', `UPDATE "User" SET "bannedAt" = now() WHERE id = ${SELLER}`],
  ['the seller is deleted', `UPDATE "User" SET "deletedAt" = now() WHERE id = ${SELLER}`],
  ['the seller is muted', `UPDATE "User" SET muted = true WHERE id = ${SELLER}`],
  [
    'the seller shop is off',
    `UPDATE "User" SET settings = '{"creatorShop":{"enabled":false}}' WHERE id = ${SELLER}`,
  ],
  // getCreatorShopSettings reads a missing setting as {}, which the shop check treats as off.
  ['the seller shop setting is unset', `UPDATE "User" SET settings = '{}' WHERE id = ${SELLER}`],
];

// The visibility decision is recorded on civitai/civitai#10252.
describe('the image page opt-in', () => {
  it('opens a shown review image to anyone at a level the deal fits', async () => {
    expect(await opens(ANON, allBrowsingLevelsFlag)).toBe(true);
    expect(await opens(STRANGER, allBrowsingLevelsFlag)).toBe(true);
  });

  it('opens to no one but moderators without the opt-in, its uploader included', async () => {
    expect(await opens(ANON, undefined)).toBe(false);
    expect(await opens(STRANGER, undefined)).toBe(false);
    expect(await opens({ userId: BUYER }, undefined)).toBe(false);
    expect(await opens(MOD, undefined)).toBe(true);
    // Any other postless image stays its owner's, as before.
    expect(await opens({ userId: BUYER }, undefined, UNRELATED)).toBe(true);
  });

  it('opens to its uploader through the opt-in, whatever the review shows', async () => {
    await db.exec(`UPDATE "ServiceDealReview" SET "hiddenAt" = now()`);
    expect(await opens({ userId: BUYER }, allBrowsingLevelsFlag)).toBe(true);
  });

  it('does not open an unrelated postless image of the same buyer', async () => {
    expect(await opens(STRANGER, allBrowsingLevelsFlag, UNRELATED)).toBe(false);
  });

  it('rates it at the deal level: over the viewer level it stays shut', async () => {
    // The image scanned PG, the deal is R: a PG/PG-13 viewer may not open it.
    expect(await opens(STRANGER, sfwBrowsingLevelsFlag)).toBe(false);
    expect(await opens(STRANGER, R)).toBe(true);
  });

  it.each<[string, string]>([
    ['the review is hidden', `UPDATE "ServiceDealReview" SET "hiddenAt" = now()`],
    ['the review is unpublished', `UPDATE "ServiceDealReview" SET "publishedAt" = NULL`],
    ['the buyer is banned', `UPDATE "User" SET "bannedAt" = now() WHERE id = ${BUYER}`],
    ['the buyer is deleted', `UPDATE "User" SET "deletedAt" = now() WHERE id = ${BUYER}`],
    ['the seller withdrew review work', `UPDATE "ServiceOffering" SET "allowReviewWork" = false`],
    ['the image awaits review', `UPDATE "Image" SET "needsReview" = 'poi'`],
    ['the image is poi', `UPDATE "Image" SET poi = true`],
    ['the image is minor', `UPDATE "Image" SET minor = true`],
    ['the image is acceptableMinor', `UPDATE "Image" SET "acceptableMinor" = true`],
    ['the image is over the deal level', `UPDATE "Image" SET "nsfwLevel" = ${X}`],
    ['the image is a ToS violation', `UPDATE "Image" SET "tosViolation" = true`],
    ['the image is not scanned', `UPDATE "Image" SET ingestion = 'Pending'`],
    ['the image is unrated', `UPDATE "Image" SET "nsfwLevel" = 0`],
    ['the image is not the buyer upload', `UPDATE "Image" SET "userId" = ${SELLER}`],
    ...OFFERING_NOT_VIEWABLE,
  ])('stays shut to a stranger when %s', async (_label, change) => {
    expect(await opens(STRANGER, allBrowsingLevelsFlag)).toBe(true);
    await db.exec(change);
    expect(await opens(STRANGER, allBrowsingLevelsFlag)).toBe(false);
    expect(await opens(ANON, allBrowsingLevelsFlag)).toBe(false);
  });

  it.each(OFFERING_NOT_VIEWABLE)(
    'still opens to its uploader and moderators when %s',
    async (_label, change) => {
      await db.exec(change);
      expect(await opens({ userId: BUYER }, allBrowsingLevelsFlag)).toBe(true);
      expect(await opens(MOD, allBrowsingLevelsFlag)).toBe(true);
    }
  );

  it('leaves a moderator read unchanged', async () => {
    await db.exec(`UPDATE "ServiceDealReview" SET "hiddenAt" = now()`);
    expect(await opens(MOD, allBrowsingLevelsFlag)).toBe(true);
    expect(await opens(MOD, undefined)).toBe(true);
  });
});

describe('a review copy whose source Final is held', () => {
  const SCAN = 990000020;
  /** Points the copy at a source Final whose scan image is `SCAN`, with `held` applied to it. */
  async function sourced(held: boolean, fileId = 1) {
    await db.exec(`
      TRUNCATE "ServiceDealFile", "ServiceDealFileEntry";
      DELETE FROM "Image" WHERE id = ${SCAN};
      INSERT INTO "Image" (id, "userId", minor) VALUES (${SCAN}, ${SELLER}, ${held});
      INSERT INTO "ServiceDealFile" (id) VALUES (1), (2);
      INSERT INTO "ServiceDealFileEntry" ("fileId", "imageId") VALUES (${fileId}, ${SCAN});
      UPDATE "ServiceDealReviewImage" SET "sourceFileId" = 1;
    `);
  }

  it('is refused to its buyer by id once the source is held', async () => {
    await sourced(true);
    expect(await opens({ userId: BUYER }, allBrowsingLevelsFlag)).toBe(false);
    expect(await opens(STRANGER, allBrowsingLevelsFlag)).toBe(false);
  });

  it('stays open to its buyer while the source is unheld, or held on another file', async () => {
    await sourced(false);
    expect(await opens({ userId: BUYER }, allBrowsingLevelsFlag)).toBe(true);
    await sourced(true, 2);
    expect(await opens({ userId: BUYER }, allBrowsingLevelsFlag)).toBe(true);
    // An ordinary postless image of the same buyer is untouched.
    expect(await opens({ userId: BUYER }, undefined, UNRELATED)).toBe(true);
  });

  it('still opens to a moderator', async () => {
    await sourced(true);
    expect(await opens(MOD, allBrowsingLevelsFlag)).toBe(true);
  });

  // The owner retracted-media route holds a moderated copy to the same rule as the image page.
  it('is refused to its buyer by the owner route once the source is held, as by the page', async () => {
    await db.exec(`
      ${CSAM_CHECK_TABLES}
      UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated', url = 'copy-key' WHERE id = ${IMAGE};
    `);
    const own = () =>
      getOwnRetractedMedia(IMAGE, BUYER, { shownReviewImageLevels: allBrowsingLevelsFlag });
    await sourced(false);
    expect(await own()).toMatchObject({ url: 'copy-key' });
    await sourced(true);
    expect(await own()).toBeNull();
  });
});

describe('the levels a request opts in at', () => {
  const ctx = ({ green = false, flags = true, signedIn = true } = {}) =>
    ({
      user: signedIn ? { id: OTHER, browsingLevel: allBrowsingLevelsFlag } : undefined,
      features: {
        canViewNsfw: !green,
        isGreen: green,
        creatorShop: flags,
        creatorServices: flags,
        creatorServicesNext: flags,
      },
      req: { headers: {} },
    } as unknown as Parameters<typeof shownReviewImageLevelsFor>[0]);

  it('is none where service reviews are not shown: the uploader alone opens it', async () => {
    const levels = shownReviewImageLevelsFor(ctx({ flags: false }));
    expect(levels).toBe(0);
    expect(await opens(STRANGER, levels)).toBe(false);
    expect(await opens({ userId: BUYER }, levels)).toBe(true);
  });

  it('holds a restricted domain to its safe levels, so an R deal stays shut there', async () => {
    const levels = shownReviewImageLevelsFor(ctx({ green: true }));
    expect(levels).toBeGreaterThan(0);
    expect(levels & ~sfwBrowsingLevelsFlag).toBe(0);
    expect(await opens(STRANGER, levels)).toBe(false);
  });

  it('holds a signed-out viewer to public levels, so an R deal stays shut', async () => {
    const levels = shownReviewImageLevelsFor(ctx({ signedIn: false }));
    expect(levels).toBeGreaterThan(0);
    expect(levels & R).toBe(0);
    expect(await opens(ANON, levels)).toBe(false);
  });
});

describe('by-id readers without the opt-in', () => {
  it('assertImageVisibleToViewer answers NOT_FOUND for a shown review image', async () => {
    expect(await opens(ANON, allBrowsingLevelsFlag)).toBe(true);
    await expect(assertImageVisibleToViewer({ id: IMAGE })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('getImageIdsVisibleToViewer drops it', async () => {
    expect(await getImageIdsVisibleToViewer({ ids: [IMAGE], userId: OTHER })).toEqual(new Set());
    expect(await getImageIdsVisibleToViewer({ ids: [IMAGE], userId: BUYER })).toEqual(new Set());
    expect(await getImageIdsVisibleToViewer({ ids: [UNRELATED], userId: BUYER })).toEqual(
      new Set([UNRELATED])
    );
  });
});

describe('surfaces a review image is refused on', () => {
  beforeEach(async () => expect(await opens(STRANGER, allBrowsingLevelsFlag)).toBe(true));

  it.each([
    ['a stranger', OTHER],
    ['its uploader', BUYER],
  ])('collect, by %s', async (_label, userId) => {
    const { assertCollectionItemsVisibleToViewer } = await import(
      '~/server/services/collection-item-visibility'
    );
    await expect(
      assertCollectionItemsVisibleToViewer({ itemKey: 'imageId', ids: [IMAGE], userId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // A cover is shown to others and goes to the collections index.
  it('a collection cover, even from an item its uploader added', async () => {
    const { servableCollectionCoverSql, itemUploadSql } = await import(
      '~/server/services/collection-cover-visibility'
    );
    const cover = (id: number) =>
      pgliteRaw(db).queryRaw`SELECT i.id FROM "Image" i LEFT JOIN "Post" p ON p.id = i."postId"
        WHERE i.id = ${id} AND ${servableCollectionCoverSql({
        postlessAllowed: itemUploadSql(Prisma.sql`${BUYER}`),
      })}`;
    expect(await cover(UNRELATED)).toHaveLength(1);
    expect(await cover(IMAGE)).toHaveLength(0);
  });

  it('reactions', async () => {
    const { toggleReactionHandler } = await import('~/server/controllers/reaction.controller');
    await expect(
      toggleReactionHandler({
        ctx: { user: { id: OTHER } } as never,
        input: { entityType: 'image', entityId: IMAGE, reaction: 'Like' } as never,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('remix', async () => {
    const { loadSource } = await import('~/server/services/remix-app.service');
    // The source row is there, so only the visibility check can refuse.
    dbMock.dbRead.image.findUnique.mockResolvedValueOnce({ id: IMAGE } as never);
    await expect(loadSource(IMAGE, { user: { id: OTHER } } as never, false)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it.each([
    ['getImageGenerationData', { id: IMAGE, viewer: { user: undefined, features: {} } }],
    ['getImageDetail', { id: IMAGE }],
    ['getImageResources', { id: IMAGE }],
  ] as const)('generation data (%s)', async (name, input) => {
    const service = await import('~/server/services/image.service');
    const read = service[name] as (input: object) => Promise<unknown>;
    await expect(read(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('comments', async () => {
    const { commentSurfaces } = await import('~/server/services/commentv3/surfaces');
    const { assertVisible } = commentSurfaces.image;
    if (!assertVisible) throw new Error('image comments have no visibility check');
    await expect(assertVisible(IMAGE, {} as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe("the review image's level and deal", () => {
  it('is the greater of the image and the deal, with the deal seller', async () => {
    const rows = await pgliteRaw(db).queryRaw`
      SELECT rw.* FROM "Image" i LEFT JOIN LATERAL ${reviewOfImageSql} rw ON TRUE
      WHERE i.id IN (${IMAGE}, ${UNRELATED}) ORDER BY i.id`;
    expect(rows).toEqual([
      { reviewId: 1, dealId: 1, sellerId: SELLER, level: R },
      { reviewId: null, dealId: null, sellerId: null, level: null },
    ]);
  });
});

describe('reporting a review image', () => {
  const report = (id: number, userId = OTHER, isModerator = false) =>
    assertImageReportable({
      id,
      userId,
      isModerator,
      shownReviewImageLevels: allBrowsingLevelsFlag,
    }).then(
      () => 'filed',
      (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message })
    );

  it('answers a hidden review image exactly as an id that names no image', async () => {
    await db.exec(`UPDATE "ServiceDealReview" SET "hiddenAt" = now()`);
    const unknown = await report(990000099);
    expect(unknown).toMatchObject({ code: 'NOT_FOUND' });
    expect(await report(IMAGE)).toEqual(unknown);
  });

  it('answers a review image behind a block with the seller as an unknown id', async () => {
    blocks = [[SELLER, OTHER]];
    expect(await report(IMAGE)).toEqual(await report(990000099));
  });

  it('files on a shown review image, and on any other image as before', async () => {
    expect(await report(IMAGE)).toBe('filed');
    expect(await report(UNRELATED)).toBe('filed');
  });

  it('files for its buyer and for a moderator while hidden', async () => {
    await db.exec(`UPDATE "ServiceDealReview" SET "hiddenAt" = now()`);
    expect(await report(IMAGE, BUYER)).toBe('filed');
    expect(await report(IMAGE, OTHER, true)).toBe('filed');
  });
});

describe('the image page behind a block', () => {
  // What the page reads after its visibility decision; empty is enough for these cases.
  beforeEach(async () => {
    const caches = await import('~/server/redis/caches');
    for (const cache of [
      caches.userCosmeticCache,
      caches.cosmeticCache,
      caches.profilePictureCache,
      caches.cosmeticEntityCaches.Image,
    ])
      vi.spyOn(cache, 'fetch').mockResolvedValue({});
  });

  const page = async (viewer: Viewer) => {
    const { getImage } = await import('~/server/services/image.service');
    return getImage({ id: IMAGE, ...viewer, shownReviewImageLevels: allBrowsingLevelsFlag }).then(
      (image) => image.id,
      (e: { code?: string }) => e.code
    );
  };

  it.each<[string, [number, number]]>([
    ['blocked by the buyer', [BUYER, OTHER]],
    ['who blocked the buyer', [OTHER, BUYER]],
    ['blocked by the seller', [SELLER, OTHER]],
    ['who blocked the seller', [OTHER, SELLER]],
  ])('is not found for a viewer %s', async (_label, block) => {
    expect(await page(STRANGER)).toBe(IMAGE);
    blocks = [block];
    expect(await page(STRANGER)).toBe('NOT_FOUND');
  });

  it("dates a held image released after publish at its release, as the feed's sortAt does", async () => {
    await db.exec(`
      INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (1, ${BUYER}, '2026-01-01');
      UPDATE "Image" SET "postId" = 1, "createdAt" = '2026-01-01', "scannedAt" = '2026-01-02'
        WHERE id IN (${IMAGE}, ${UNRELATED});
      UPDATE "Image" SET "firstVisibleAt" = '2026-01-04' WHERE id = ${IMAGE};
    `);
    const { getImage } = await import('~/server/services/image.service');
    const publishedAt = (id: number) =>
      getImage({ id, ...MOD, shownReviewImageLevels: allBrowsingLevelsFlag }).then((image) =>
        new Date(image.publishedAt as Date).toISOString()
      );
    expect(await publishedAt(IMAGE)).toBe('2026-01-04T00:00:00.000Z');
    // No firstVisibleAt: GREATEST(publishedAt, scannedAt, createdAt).
    expect(await publishedAt(UNRELATED)).toBe('2026-01-02T00:00:00.000Z');
  });

  it("reads the owner CSAM check for the image's owner, only with the owner-media read on", async () => {
    await db.exec(`
      ${CSAM_CHECK_TABLES}
      UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = ${UNRELATED};
    `);
    const { getImage } = await import('~/server/services/image.service');
    const marked = (viewer: Viewer, ownerReviewedBlocks?: boolean) =>
      getImage({
        id: UNRELATED,
        ...viewer,
        ownerReviewedBlocks,
        shownReviewImageLevels: allBrowsingLevelsFlag,
      }).then((image) => (image as { ownerCsamMarked?: boolean | null }).ownerCsamMarked);
    expect(await marked({ userId: BUYER }, true)).toBe(false);
    expect(await marked({ userId: BUYER })).toBeUndefined();
    expect(await marked(MOD, true)).toBeNull();
  });

  it('still serves its buyer and a moderator through a block', async () => {
    blocks = [[SELLER, BUYER]];
    expect(await page({ userId: BUYER })).toBe(IMAGE);
    blocks = [
      [BUYER, OTHER],
      [SELLER, OTHER],
    ];
    expect(await page(MOD)).toBe(IMAGE);
  });
});
