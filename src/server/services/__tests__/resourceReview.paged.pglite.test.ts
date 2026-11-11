import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import type * as UserService from '~/server/services/user.service';

/**
 * The `/models/<id>/reviews` list. Its SQL runs against PGlite; the viewer's hidden/blocked lists
 * and the user decorations are stubbed. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const blockedBy = vi.hoisted(() => ({ ids: [] as number[] }));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const none = { getCached: async () => [] };
  return {
    ...(await importOriginal<typeof UserPreferences>()),
    HiddenUsers: none,
    BlockedByUsers: { getCached: async () => blockedBy.ids.map((id) => ({ id })) },
    BlockedUsers: none,
  };
});
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getBasicDataForUsers: async (ids: number[]) =>
    Object.fromEntries(ids.map((id) => [id, { username: `u${id}`, image: null, deletedAt: null }])),
  getCosmeticsForUsers: async () => ({}),
  getProfilePicturesForUsers: async () => ({}),
}));

const { getPagedResourceReviews } = await import('~/server/services/resourceReview.service');
const { REVIEW_IMAGE_COUNT_CAP } = await import('~/server/schema/resourceReview.schema');
const { NsfwLevel } = await import('~/server/common/enums');

const MODEL = 10;
const V1 = 20;
const V2 = 21;
const OTHER_MODEL = 11;
const OTHER_VERSION = 30;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "CommentEntityType" AS ENUM ('review', 'challenge');
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Private', 'Unsearchable', 'EarlyAccess');
    CREATE TABLE "Post" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "publishedAt" timestamp,
      availability "Availability" NOT NULL DEFAULT 'Public',
      metadata jsonb
    );
    CREATE TABLE "ResourceReview" (
      id int PRIMARY KEY,
      "modelId" int NOT NULL,
      "modelVersionId" int NOT NULL,
      "userId" int NOT NULL,
      "postId" int,
      rating int NOT NULL DEFAULT 5,
      recommended boolean NOT NULL DEFAULT true,
      details text,
      "createdAt" timestamp NOT NULL,
      nsfw boolean NOT NULL DEFAULT false,
      exclude boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false,
      metadata jsonb
    );
    CREATE TABLE "Image" ( type "MediaType" NOT NULL DEFAULT 'image',
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "postId" int,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "needsReview" text,
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 1,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      metadata jsonb,
      "scanJobs" jsonb
    );
    CREATE TABLE "ImageResourceNew" (
      "imageId" int NOT NULL,
      "modelVersionId" int NOT NULL,
      PRIMARY KEY ("imageId", "modelVersionId")
    );
    CREATE TABLE "CommentV3" (
      id serial PRIMARY KEY,
      "entityType" "CommentEntityType" NOT NULL,
      "entityId" int NOT NULL,
      "parentId" int,
      "deletedAt" timestamp,
      "tosViolation" boolean NOT NULL DEFAULT false
    );
  `);
});
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(`TRUNCATE "Post", "ResourceReview", "Image", "ImageResourceNew", "CommentV3";`);
  blockedBy.ids = [];
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return (await pg.query(sql.text, sql.values as unknown[])).rows;
  }) as never);
});

type Review = {
  id: number;
  modelId?: number;
  versionId?: number;
  userId?: number;
  postId?: number | null;
  details?: string | null;
  daysAgo: number;
};
const insertReviews = (rows: Review[]) =>
  pg.query(
    `INSERT INTO "ResourceReview" (id, "modelId", "modelVersionId", "userId", "postId", details, "createdAt")
     SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::int[], $5::int[], $6::text[], $7::timestamp[])`,
    [
      rows.map((r) => r.id),
      rows.map((r) => r.modelId ?? MODEL),
      rows.map((r) => r.versionId ?? V1),
      rows.map((r) => r.userId ?? r.id),
      rows.map((r) => r.postId ?? null),
      rows.map((r) => r.details ?? null),
      rows.map((r) => new Date(Date.UTC(2026, 0, 31 - r.daysAgo))),
    ]
  );

const page = (input: { modelVersionId?: number; page?: number; limit?: number }, userId?: number) =>
  getPagedResourceReviews({ input: { modelId: MODEL, limit: 10, page: 1, ...input }, userId });

describe('getPagedResourceReviews', () => {
  it("lists every version's reviews of the model when no version is selected", async () => {
    await insertReviews([
      { id: 1, versionId: V1, daysAgo: 3 },
      { id: 2, versionId: V2, daysAgo: 2 },
      { id: 3, modelId: OTHER_MODEL, versionId: OTHER_VERSION, daysAgo: 1 },
    ]);

    const all = await page({});
    expect(all.items.map((r) => r.id)).toEqual([2, 1]);
    expect(all.totalItems).toBe(2);

    expect((await page({ modelVersionId: V2 })).items.map((r) => r.id)).toEqual([2]);
  });

  it("counts the visible images of the review's own post that used the reviewed version", async () => {
    const AUTHOR = 5;
    await pg.exec(`
      INSERT INTO "Post" (id, "userId", "publishedAt") VALUES
        (100, ${AUTHOR}, now() - interval '1 day'),
        (101, ${AUTHOR}, now() - interval '1 day');
      INSERT INTO "Image" (id, "userId", "postId", "needsReview") VALUES
        (1, ${AUTHOR}, 100, NULL),
        (2, ${AUTHOR}, 100, 'minor'),
        (3, ${AUTHOR}, 100, NULL),
        (4, ${AUTHOR}, 101, NULL);
      INSERT INTO "ImageResourceNew" VALUES (1, ${V1}), (2, ${V1}), (3, ${V2}), (4, ${V1});
    `);
    await insertReviews([{ id: 1, userId: AUTHOR, postId: 100, daysAgo: 1 }]);

    const [review] = (await page({ modelVersionId: V1 })).items;
    expect(review.imageCount).toBe(1);
  });

  // The version having fewer images than the reviewer, or more, picks which side the count walks.
  it.each([
    ['a version with few images', { authorOnly: 10, othersWithVersion: 0 }],
    ['a version with many images', { authorOnly: 0, othersWithVersion: 10 }],
  ])(
    "counts the reviewer's published images with %s when the review has no post",
    async (_label, { authorOnly, othersWithVersion }) => {
      const AUTHOR = 6;
      await pg.exec(`
      INSERT INTO "Image" (id, "userId", "postId")
        SELECT 1000 + g, 99, 204 FROM generate_series(1, ${othersWithVersion}) g;
      INSERT INTO "ImageResourceNew"
        SELECT 1000 + g, ${V1} FROM generate_series(1, ${othersWithVersion}) g;
      INSERT INTO "Image" (id, "userId", "postId")
        SELECT 2000 + g, ${AUTHOR}, 200 FROM generate_series(1, ${authorOnly}) g;
    `);
      await pg.exec(`
      INSERT INTO "Post" (id, "userId", "publishedAt", availability) VALUES
        (200, ${AUTHOR}, now() - interval '1 day', 'Public'),
        (201, ${AUTHOR}, now() - interval '2 day', 'Public'),
        (202, ${AUTHOR}, NULL, 'Public'),
        (203, ${AUTHOR}, now() - interval '1 day', 'Private'),
        (204, 99, now() - interval '1 day', 'Public');
      INSERT INTO "Image" (id, "userId", "postId", ingestion) VALUES
        (10, ${AUTHOR}, 200, 'Scanned'),
        (11, ${AUTHOR}, 201, 'Scanned'),
        (12, ${AUTHOR}, 202, 'Scanned'),
        (13, ${AUTHOR}, 203, 'Scanned'),
        (14, ${AUTHOR}, 200, 'Pending'),
        (15, ${AUTHOR}, 200, 'Scanned'),
        (16, 99, 204, 'Scanned');
      INSERT INTO "ImageResourceNew" VALUES
        (10, ${V1}), (11, ${V1}), (12, ${V1}), (13, ${V1}), (14, ${V1}), (15, ${V2}), (16, ${V1});
    `);
      await insertReviews([{ id: 1, userId: AUTHOR, postId: null, daysAgo: 1 }]);

      const [review] = (await page({ modelVersionId: V1 })).items;
      expect(review.imageCount).toBe(2);
    }
  );

  it('caps each image count at one over the cap, so the page can show "100+"', async () => {
    const AUTHOR = 7;
    const over = REVIEW_IMAGE_COUNT_CAP + 20;
    await pg.exec(`
      INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (300, ${AUTHOR}, now() - interval '1 day');
      INSERT INTO "Image" (id, "userId", "postId")
        SELECT g, ${AUTHOR}, 300 FROM generate_series(1, ${over}) g;
      INSERT INTO "ImageResourceNew" SELECT g, ${V1} FROM generate_series(1, ${over}) g;
    `);
    await insertReviews([
      { id: 1, userId: AUTHOR, postId: 300, daysAgo: 1 },
      { id: 2, userId: AUTHOR, postId: null, daysAgo: 2 },
    ]);

    const counts = (await page({ modelVersionId: V1 })).items.map((r) => r.imageCount);
    expect(counts).toEqual([REVIEW_IMAGE_COUNT_CAP + 1, REVIEW_IMAGE_COUNT_CAP + 1]);
  });

  it("excludes blocked images and the review's unpublished, Private or stamped post", async () => {
    const AUTHOR = 8;
    await pg.exec(`
      INSERT INTO "Post" (id, "userId", "publishedAt", availability, metadata) VALUES
        (400, ${AUTHOR}, now() - interval '1 day', 'Public', NULL),
        (401, ${AUTHOR}, NULL, 'Public', NULL),
        (402, ${AUTHOR}, now() - interval '1 day', 'Private', NULL),
        (403, ${AUTHOR}, now() - interval '1 day', 'Public', '{"unpublishedAt": "2026-01-01"}');
      INSERT INTO "Image" (id, "userId", "postId", "blockedFor", "nsfwLevel") VALUES
        (40, ${AUTHOR}, 400, NULL, 1),
        (41, ${AUTHOR}, 400, 'tos', 1),
        (42, ${AUTHOR}, 400, NULL, ${NsfwLevel.Blocked}),
        (43, ${AUTHOR}, 401, NULL, 1),
        (44, ${AUTHOR}, 402, NULL, 1),
        (45, ${AUTHOR}, 403, NULL, 1);
      INSERT INTO "ImageResourceNew" VALUES (40, ${V1}), (41, ${V1}), (42, ${V1}), (43, ${V1}), (44, ${V1}), (45, ${V1});
    `);
    await insertReviews([
      { id: 1, userId: AUTHOR, postId: 400, daysAgo: 1 },
      { id: 2, userId: AUTHOR, postId: 401, daysAgo: 2 },
      { id: 3, userId: AUTHOR, postId: 402, daysAgo: 3 },
      { id: 4, userId: AUTHOR, postId: 403, daysAgo: 4 },
      { id: 5, userId: AUTHOR, postId: null, daysAgo: 5 },
    ]);

    // As the author, who alone sees the review on the unpublished post. The postless review falls
    // back to the reviewer's servable images: only image 40.
    const counts = (await page({ modelVersionId: V1 }, AUTHOR)).items.map((r) => [
      r.id,
      r.imageCount,
    ]);
    expect(counts).toEqual([
      [1, 1],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 1],
    ]);
  });

  it('counts 0 for a review with no matching image', async () => {
    const AUTHOR = 9;
    await pg.exec(`
      INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (500, ${AUTHOR}, now() - interval '1 day');
      INSERT INTO "Image" (id, "userId", "postId") VALUES (50, ${AUTHOR}, 500);
      INSERT INTO "ImageResourceNew" VALUES (50, ${V2});
    `);
    await insertReviews([
      { id: 1, userId: AUTHOR, postId: 500, daysAgo: 1 },
      { id: 2, userId: AUTHOR, postId: null, daysAgo: 2 },
    ]);

    const counts = (await page({ modelVersionId: V1 })).items.map((r) => r.imageCount);
    expect(counts).toEqual([0, 0]);
  });

  it('caps the count when the version has fewer images than the reviewer', async () => {
    const AUTHOR = 10;
    const over = REVIEW_IMAGE_COUNT_CAP + 20;
    await pg.exec(`
      INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (600, ${AUTHOR}, now() - interval '1 day');
      INSERT INTO "Image" (id, "userId", "postId")
        SELECT g, ${AUTHOR}, 600 FROM generate_series(1, ${over + 50}) g;
      INSERT INTO "ImageResourceNew" SELECT g, ${V1} FROM generate_series(1, ${over}) g;
    `);
    await insertReviews([{ id: 1, userId: AUTHOR, postId: null, daysAgo: 1 }]);

    const [review] = (await page({ modelVersionId: V1 })).items;
    expect(review.imageCount).toBe(REVIEW_IMAGE_COUNT_CAP + 1);
  });

  describe("a blocker's review, with no version selected", () => {
    const OWNER = 70;
    const BLOCKER = 71;
    beforeEach(async () => {
      blockedBy.ids = [BLOCKER];
      dbMock.dbRead.model.findUnique.mockImplementation((async ({
        where,
      }: {
        where: { id: number };
      }) => (where.id === MODEL ? { userId: OWNER } : null)) as never);
      await insertReviews([
        { id: 1, userId: BLOCKER, versionId: V1, daysAgo: 1 },
        { id: 2, userId: 72, versionId: V2, daysAgo: 2 },
      ]);
    });

    it('still shows to the model owner', async () => {
      expect((await page({}, OWNER)).items.map((r) => r.id)).toEqual([1, 2]);
    });

    it('is hidden from any other viewer', async () => {
      expect((await page({}, 73)).items.map((r) => r.id)).toEqual([2]);
    });
  });

  it('lists reviews newest first across pages, written or not', async () => {
    await insertReviews([
      { id: 1, details: '<p>Great with the turbo base.</p>', daysAgo: 9 },
      { id: 2, details: '<p></p>', daysAgo: 1 },
      { id: 3, daysAgo: 2 },
      { id: 4, details: '<p>Solid hands.</p>', daysAgo: 8 },
      { id: 5, daysAgo: 3 },
    ]);

    const first = await page({ modelVersionId: V1, limit: 2, page: 1 });
    const second = await page({ modelVersionId: V1, limit: 2, page: 2 });
    const third = await page({ modelVersionId: V1, limit: 2, page: 3 });

    expect([...first.items, ...second.items, ...third.items].map((r) => r.id)).toEqual([
      2, 3, 5, 4, 1,
    ]);
  });
});
