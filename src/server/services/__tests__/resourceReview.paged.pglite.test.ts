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
const { allBrowsingLevelsFlag } = await import('~/shared/constants/browsingLevel.constants');

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
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "postId" int,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "needsReview" text,
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 1,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false,
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
  recommended?: boolean;
  daysAgo: number;
};
const insertReviews = (rows: Review[]) =>
  pg.query(
    `INSERT INTO "ResourceReview" (id, "modelId", "modelVersionId", "userId", "postId", details, "createdAt", recommended)
     SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::int[], $5::int[], $6::text[], $7::timestamp[], $8::boolean[])`,
    [
      rows.map((r) => r.id),
      rows.map((r) => r.modelId ?? MODEL),
      rows.map((r) => r.versionId ?? V1),
      rows.map((r) => r.userId ?? r.id),
      rows.map((r) => r.postId ?? null),
      rows.map((r) => r.details ?? null),
      rows.map((r) => new Date(Date.UTC(2026, 0, 31 - r.daysAgo))),
      rows.map((r) => r.recommended ?? true),
    ]
  );

const page = (
  input: {
    modelVersionId?: number;
    page?: number;
    limit?: number;
    writtenOnly?: boolean;
    hasImages?: boolean;
    recommended?: boolean;
    browsingLevel?: number;
  },
  userId?: number
) =>
  getPagedResourceReviews({
    input: {
      modelId: MODEL,
      limit: 10,
      page: 1,
      browsingLevel: allBrowsingLevelsFlag,
      ...input,
    },
    userId,
  });

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

  describe("the viewer's browsing level", () => {
    const AUTHOR = 40;
    beforeEach(async () => {
      await pg.exec(`
        INSERT INTO "Post" (id, "userId", "publishedAt") VALUES
          (2000, ${AUTHOR}, now() - interval '1 day'),
          (2001, ${AUTHOR}, now() - interval '1 day');
        INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel") VALUES
          (50, ${AUTHOR}, 2000, ${NsfwLevel.PG}),
          (51, ${AUTHOR}, 2000, ${NsfwLevel.R}),
          (52, ${AUTHOR}, 2001, ${NsfwLevel.R});
        INSERT INTO "ImageResourceNew" VALUES (50, ${V1}), (51, ${V1}), (52, ${V1});
      `);
      await insertReviews([
        { id: 1, userId: AUTHOR, postId: 2000, daysAgo: 1 },
        { id: 2, userId: AUTHOR, postId: 2001, daysAgo: 2 },
      ]);
    });

    it('does not count images above the level', async () => {
      const sfw = await page({ modelVersionId: V1, browsingLevel: NsfwLevel.PG });
      expect(sfw.items.map((r) => [r.id, r.imageCount])).toEqual([
        [1, 1],
        [2, 0],
      ]);
      const all = await page({ modelVersionId: V1 });
      expect(all.items.map((r) => [r.id, r.imageCount])).toEqual([
        [1, 2],
        [2, 1],
      ]);
    });

    it('keeps in hasImages only reviews with an image within the level', async () => {
      const sfw = await page({ modelVersionId: V1, hasImages: true, browsingLevel: NsfwLevel.PG });
      expect(sfw.items.map((r) => r.id)).toEqual([1]);
    });
  });

  // A review outside a post counts the reviewer's own images; the level must apply on both sides of
  // that walk and in the `hasImages` reviewer lookup.
  describe("the viewer's browsing level, for a review with no post", () => {
    // The reviewer has more images than the version, or fewer: picks which side the count walks.
    it.each([
      ['a reviewer with more images than the version', { reviewerPad: 10, versionPad: 0 }],
      ['a version with more images than the reviewer', { reviewerPad: 0, versionPad: 10 }],
    ])('hides an R image from a PG viewer for %s', async (_label, { reviewerPad, versionPad }) => {
      const AUTHOR = 50;
      await pg.exec(`
        INSERT INTO "Post" (id, "userId", "publishedAt") VALUES
          (700, ${AUTHOR}, now() - interval '1 day'),
          (701, 99, now() - interval '1 day');
        INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel") VALUES (1, ${AUTHOR}, 700, ${NsfwLevel.R});
        INSERT INTO "ImageResourceNew" VALUES (1, ${V1});
        INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel")
          SELECT 100 + g, ${AUTHOR}, 700, ${NsfwLevel.PG} FROM generate_series(1, ${reviewerPad}) g;
        INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel")
          SELECT 200 + g, 99, 701, ${NsfwLevel.PG} FROM generate_series(1, ${versionPad}) g;
        INSERT INTO "ImageResourceNew" SELECT 200 + g, ${V1} FROM generate_series(1, ${versionPad}) g;
      `);
      await insertReviews([{ id: 1, userId: AUTHOR, postId: null, daysAgo: 1 }]);

      const sfw = await page({ modelVersionId: V1, browsingLevel: NsfwLevel.PG });
      expect(sfw.items.map((r) => r.imageCount)).toEqual([0]);
      const sfwWithImages = await page({
        modelVersionId: V1,
        hasImages: true,
        browsingLevel: NsfwLevel.PG,
      });
      expect(sfwWithImages.items).toEqual([]);

      // At a level that includes R the same review counts it and matches.
      const all = await page({ modelVersionId: V1 });
      expect(all.items.map((r) => r.imageCount)).toEqual([1]);
      expect((await page({ modelVersionId: V1, hasImages: true })).items.map((r) => r.id)).toEqual([
        1,
      ]);
    });
  });

  // The image feed (`getAllImages`) drops `acceptableMinor` images for every viewer outside the
  // pending view, so the counts and `hasImages` must too or they promise images the card can't load.
  it('does not count or match acceptableMinor images, for the owner either', async () => {
    const AUTHOR = 51;
    await pg.exec(`
      INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (710, ${AUTHOR}, now() - interval '1 day');
      INSERT INTO "Image" (id, "userId", "postId", "acceptableMinor") VALUES
        (1, ${AUTHOR}, 710, true), (2, ${AUTHOR}, 710, false);
      INSERT INTO "ImageResourceNew" VALUES (1, ${V1}), (2, ${V1});
      INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (711, 52, now() - interval '1 day');
      INSERT INTO "Image" (id, "userId", "postId", "acceptableMinor") VALUES (3, 52, 711, true);
      INSERT INTO "ImageResourceNew" VALUES (3, ${V1});
    `);
    await insertReviews([
      { id: 1, userId: AUTHOR, postId: 710, daysAgo: 1 },
      { id: 2, userId: 52, postId: 711, daysAgo: 2 },
      { id: 3, userId: 52, postId: null, daysAgo: 3 },
    ]);

    for (const viewer of [undefined, AUTHOR, 52]) {
      const result = await page({ modelVersionId: V1 }, viewer);
      expect(
        result.items.map((r) => [r.id, r.imageCount]),
        `viewer ${viewer}`
      ).toEqual([
        [1, 1],
        [2, 0],
        [3, 0],
      ]);
    }
    const withImages = await page({ modelVersionId: V1, hasImages: true });
    expect(withImages.items.map((r) => r.id)).toEqual([1]);
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

  it("returns each review's postId", async () => {
    await pg.exec(
      `INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (900, 1, now() - interval '1 day')`
    );
    await insertReviews([
      { id: 1, postId: 900, daysAgo: 1 },
      { id: 2, postId: null, daysAgo: 2 },
    ]);

    const items = (await page({})).items;
    expect(items.map((r) => [r.id, r.postId])).toEqual([
      [1, 900],
      [2, null],
    ]);
  });

  it.each([
    [true, [1, 3]],
    [false, [2]],
  ])(
    'recommended: %s keeps only matching thumbs, with a matching total',
    async (recommended, ids) => {
      await insertReviews([
        { id: 1, recommended: true, daysAgo: 3 },
        { id: 2, recommended: false, daysAgo: 2 },
        { id: 3, recommended: true, daysAgo: 1 },
      ]);

      const result = await page({ recommended });
      expect(result.items.map((r) => r.id)).toEqual(ids.slice().reverse());
      expect(result.totalItems).toBe(ids.length);
    }
  );

  describe('hasImages', () => {
    const AUTHOR = 20;
    beforeEach(async () => {
      await pg.exec(`
        INSERT INTO "Post" (id, "userId", "publishedAt") VALUES
          (1000, ${AUTHOR}, now() - interval '1 day'),
          (1001, ${AUTHOR}, now() - interval '1 day'),
          (1002, ${AUTHOR}, now() - interval '1 day'),
          (1003, 21, now() - interval '1 day');
        INSERT INTO "Image" (id, "userId", "postId", "needsReview") VALUES
          (1, ${AUTHOR}, 1000, NULL),
          (2, ${AUTHOR}, 1001, 'minor'),
          (3, ${AUTHOR}, 1002, NULL),
          (4, 21, 1003, NULL);
        INSERT INTO "ImageResourceNew" VALUES (1, ${V1}), (2, ${V1}), (3, ${V2}), (4, ${V1});
      `);
      await insertReviews([
        { id: 1, userId: AUTHOR, postId: 1000, details: '<p>with image</p>', daysAgo: 1 },
        { id: 2, userId: AUTHOR, postId: 1001, details: '<p>unservable image</p>', daysAgo: 2 },
        { id: 3, userId: AUTHOR, postId: 1002, details: '<p>other version image</p>', daysAgo: 3 },
        { id: 4, userId: 22, postId: null, details: '<p>no post, no images</p>', daysAgo: 4 },
        { id: 5, userId: 21, postId: null, daysAgo: 5 },
      ]);
    });

    it('keeps a review with a servable post image and drops the rest, counting the same images as imageCount', async () => {
      const result = await page({ modelVersionId: V1, hasImages: true });
      expect(result.items.map((r) => r.id)).toEqual([1, 5]);
      expect(result.items.every((r) => r.imageCount > 0)).toBe(true);
      expect(result.totalItems).toBe(2);
    });

    it('pages by hasMore without counting', async () => {
      await pg.exec(`
        INSERT INTO "Post" (id, "userId", "publishedAt") VALUES
          (1010, 30, now() - interval '1 day'),
          (1011, 31, now() - interval '1 day');
        INSERT INTO "Image" (id, "userId", "postId") VALUES (10, 30, 1010), (11, 31, 1011);
        INSERT INTO "ImageResourceNew" VALUES (10, ${V1}), (11, ${V1});
      `);
      await insertReviews([
        { id: 6, userId: 30, postId: 1010, daysAgo: 6 },
        { id: 7, userId: 31, postId: 1011, daysAgo: 7 },
      ]);

      const first = await page({ modelVersionId: V1, hasImages: true, limit: 1, page: 1 });
      expect(first.items.map((r) => r.id)).toEqual([1]);
      expect(first.hasMore).toBe(true);

      const last = await page({ modelVersionId: V1, hasImages: true, limit: 3, page: 2 });
      expect(last.items.map((r) => r.id)).toEqual([7]);
      expect(last.hasMore).toBe(false);
    });

    it('combines with writtenOnly', async () => {
      const result = await page({ modelVersionId: V1, hasImages: true, writtenOnly: true });
      expect(result.items.map((r) => r.id)).toEqual([1]);
    });
  });
});
