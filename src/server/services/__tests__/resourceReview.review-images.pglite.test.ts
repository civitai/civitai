import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import type * as UserService from '~/server/services/user.service';

/**
 * The images a review card shows must be the ones its `imageCount` counts. Both run against
 * PGlite; the viewer's hidden/blocked lists and the user decorations are stubbed. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const prefs = vi.hoisted(() => ({ hidden: [] as number[], blockedBy: [] as number[] }));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  HiddenUsers: { getCached: async () => prefs.hidden.map((id) => ({ id })) },
  BlockedByUsers: { getCached: async () => prefs.blockedBy.map((id) => ({ id })) },
  BlockedUsers: { getCached: async () => [] },
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getBasicDataForUsers: async (ids: number[]) =>
    Object.fromEntries(ids.map((id) => [id, { username: `u${id}`, image: null, deletedAt: null }])),
  getCosmeticsForUsers: async () => ({}),
  getProfilePicturesForUsers: async () => ({}),
}));

const { getPagedResourceReviews, getReviewImageIds } = await import(
  '~/server/services/resourceReview.service'
);
const { NsfwLevel } = await import('~/server/common/enums');
const { allBrowsingLevelsFlag } = await import('~/shared/constants/browsingLevel.constants');

const MODEL = 10;
const V1 = 20;
const V2 = 21;
const AUTHOR = 5;

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
      "createdAt" timestamp NOT NULL DEFAULT now(),
      nsfw boolean NOT NULL DEFAULT false,
      exclude boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false,
      metadata jsonb
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "postId" int,
      "index" int,
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
  prefs.hidden = [];
  prefs.blockedBy = [];
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return (await pg.query(sql.text, sql.values as unknown[])).rows;
  }) as never);
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(null as never);
});

const insertReview = (id: number, postId: number | null, versionId = V1) =>
  pg.query(
    `INSERT INTO "ResourceReview" (id, "modelId", "modelVersionId", "userId", "postId")
     VALUES ($1, ${MODEL}, $2, ${AUTHOR}, $3)`,
    [id, versionId, postId]
  );

const countOf = async (
  reviewId: number,
  browsingLevel = allBrowsingLevelsFlag,
  viewer?: number
) => {
  const { items } = await getPagedResourceReviews({
    input: { modelId: MODEL, limit: 10, page: 1, browsingLevel },
    userId: viewer,
  });
  return items.find((r) => r.id === reviewId)?.imageCount;
};

// Images that every review below must leave out, whatever its shape.
const NOISE = `
  (30, ${AUTHOR}, 100, NULL, 'Scanned', NULL, NULL, 1, FALSE),
  (31, ${AUTHOR}, 100, NULL, 'Scanned', 'minor', NULL, 1, FALSE),
  (32, ${AUTHOR}, 100, NULL, 'Scanned', NULL, 'tos', 1, FALSE),
  (33, ${AUTHOR}, 100, NULL, 'Scanned', NULL, NULL, 1, TRUE),
  (34, ${AUTHOR}, 100, NULL, 'Pending', NULL, NULL, 1, FALSE),
  (35, ${AUTHOR}, 102, NULL, 'Scanned', NULL, NULL, 1, FALSE),
  (36, ${AUTHOR}, 100, NULL, 'Scanned', NULL, NULL, ${NsfwLevel.R}, FALSE)
`;
const NOISE_ON_V1 = [30, 31, 32, 33, 34, 35, 36];

const seedPosts = () =>
  pg.exec(`
    INSERT INTO "Post" (id, "userId", "publishedAt") VALUES
      (100, ${AUTHOR}, now() - interval '1 day'),
      (101, ${AUTHOR}, now() - interval '1 day'),
      (102, ${AUTHOR}, NULL);
  `);

const seedImages = async (extra: string) => {
  await pg.exec(`
    INSERT INTO "Image" (id, "userId", "postId", "index", ingestion, "needsReview", "blockedFor", "nsfwLevel", "acceptableMinor")
    VALUES ${extra}, ${NOISE};
  `);
};

describe('getReviewImageIds', () => {
  describe('a review with a post', () => {
    beforeEach(async () => {
      await seedPosts();
      await seedImages(`
        (1, ${AUTHOR}, 100, 1, 'Scanned', NULL, NULL, 1, FALSE),
        (2, ${AUTHOR}, 100, 0, 'Scanned', NULL, NULL, 1, FALSE),
        (3, ${AUTHOR}, 100, 2, 'Scanned', NULL, NULL, 1, FALSE),
        (4, ${AUTHOR}, 101, 0, 'Scanned', NULL, NULL, 1, FALSE)
      `);
      await pg.exec(`
        INSERT INTO "ImageResourceNew" VALUES (1, ${V1}), (2, ${V1}), (3, ${V2}), (4, ${V1});
        INSERT INTO "ImageResourceNew" SELECT id, ${V1} FROM unnest(ARRAY[${NOISE_ON_V1.join(
        ','
      )}]) id;
      `);
      await insertReview(1, 100);
    });

    it("returns the review's post images that used the version, in the post's order, and the count agrees", async () => {
      const ids = await getReviewImageIds({
        reviewId: 1,
        limit: 10,
        browsingLevel: allBrowsingLevelsFlag & ~NsfwLevel.R,
      });
      // 3 used another version, 4 sits in another post, 31-35 are unservable and 36 is above the level.
      expect(ids).toEqual([2, 1, 30]);
      expect(ids.length).toBe(await countOf(1, allBrowsingLevelsFlag & ~NsfwLevel.R));
    });

    it('applies the level: an R image shows to a level that includes R and not to PG', async () => {
      const all = await getReviewImageIds({
        reviewId: 1,
        limit: 10,
        browsingLevel: allBrowsingLevelsFlag,
      });
      const pg1 = await getReviewImageIds({ reviewId: 1, limit: 10, browsingLevel: NsfwLevel.PG });
      expect(all).toContain(36);
      expect(pg1).not.toContain(36);
      expect(all.length).toBe(await countOf(1));
      expect(pg1.length).toBe(await countOf(1, NsfwLevel.PG));
    });

    it('stops at the limit', async () => {
      expect(
        await getReviewImageIds({ reviewId: 1, limit: 2, browsingLevel: NsfwLevel.PG })
      ).toEqual([2, 1]);
    });
  });

  describe('a review without a post', () => {
    // Reviewer walk and version walk are chosen by which side is smaller: cover both.
    it.each([
      ['a reviewer with more images than the version', { reviewerPad: 10, versionPad: 0 }],
      ['a version with more images than the reviewer', { reviewerPad: 0, versionPad: 10 }],
    ])('returns what the count counts for %s', async (_label, { reviewerPad, versionPad }) => {
      await seedPosts();
      await pg.exec(
        `INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (200, 99, now() - interval '1 day');`
      );
      await seedImages(`
        (1, ${AUTHOR}, 100, 0, 'Scanned', NULL, NULL, 1, FALSE),
        (2, ${AUTHOR}, 101, 0, 'Scanned', NULL, NULL, 1, FALSE),
        (3, ${AUTHOR}, 101, 0, 'Scanned', NULL, NULL, 1, FALSE),
        (4, 99, 200, 0, 'Scanned', NULL, NULL, 1, FALSE)
      `);
      await pg.exec(`
        INSERT INTO "ImageResourceNew" VALUES (1, ${V1}), (2, ${V1}), (3, ${V2}), (4, ${V1});
        INSERT INTO "ImageResourceNew" SELECT id, ${V1} FROM unnest(ARRAY[${NOISE_ON_V1.join(
        ','
      )}]) id;
        INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel")
          SELECT 500 + g, ${AUTHOR}, 100, 1 FROM generate_series(1, ${reviewerPad}) g;
        INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel")
          SELECT 700 + g, 99, 200, 1 FROM generate_series(1, ${versionPad}) g;
        INSERT INTO "ImageResourceNew" SELECT 700 + g, ${V1} FROM generate_series(1, ${versionPad}) g;
      `);
      await insertReview(1, null);

      const level = allBrowsingLevelsFlag & ~NsfwLevel.R;
      const ids = await getReviewImageIds({ reviewId: 1, limit: 50, browsingLevel: level });
      expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 30]);
      expect(ids.length).toBe(await countOf(1, level));
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
    });
  });

  describe('a review without a post, when the version and the reviewer both have many images', () => {
    it('walks only the reviewer’s newest images', async () => {
      await seedPosts();
      await pg.exec(`
        INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel")
          SELECT g, ${AUTHOR}, 100, 1 FROM generate_series(1, 5100) g;
        INSERT INTO "ImageResourceNew" VALUES (1, ${V1}), (5000, ${V1}), (5100, ${V1});
        INSERT INTO "ImageResourceNew" SELECT 100000 + g, ${V1} FROM generate_series(1, 1000) g;
      `);
      await insertReview(1, null);

      const ids = await getReviewImageIds({
        reviewId: 1,
        limit: 10,
        browsingLevel: allBrowsingLevelsFlag,
      });
      // Image 1 is older than the reviewer's newest 5000 images, so it is not found.
      expect(ids).toEqual([5100, 5000]);
      expect(await countOf(1)).toBe(2);
    });
  });

  describe('a review the viewer cannot see', () => {
    beforeEach(async () => {
      await seedPosts();
      await seedImages(`(1, ${AUTHOR}, 102, 0, 'Scanned', NULL, NULL, 1, FALSE)`);
      await pg.exec(`INSERT INTO "ImageResourceNew" VALUES (1, ${V1});`);
    });

    it('is empty for a review written from an unpublished post, even to its author', async () => {
      // The post-image predicate hides an unpublished post's images, so even its author gets none.
      await insertReview(1, 102);
      const input = { reviewId: 1, limit: 10, browsingLevel: allBrowsingLevelsFlag };
      expect(await getReviewImageIds({ ...input })).toEqual([]);
      expect(await getReviewImageIds({ ...input, userId: 77 })).toEqual([]);
      expect(await getReviewImageIds({ ...input, userId: AUTHOR })).toEqual([]);
    });

    it('is empty for a hidden or blocking reviewer, and for a review that does not exist', async () => {
      await pg.exec(`INSERT INTO "ImageResourceNew" VALUES (30, ${V1});`);
      await insertReview(1, null);
      const input = { reviewId: 1, limit: 10, browsingLevel: allBrowsingLevelsFlag, userId: 77 };
      expect(await getReviewImageIds(input)).toEqual([30]);
      prefs.hidden = [AUTHOR];
      expect(await getReviewImageIds(input)).toEqual([]);
      prefs.hidden = [];
      prefs.blockedBy = [AUTHOR];
      expect(await getReviewImageIds(input)).toEqual([]);
      prefs.blockedBy = [];
      expect(await getReviewImageIds({ ...input, reviewId: 999 })).toEqual([]);
    });
  });
});
