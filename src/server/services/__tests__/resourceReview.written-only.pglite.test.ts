import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { getResourceReviewPagedSchema } from '~/server/schema/resourceReview.schema';
import { writtenReviewSql } from '~/server/services/resourceReview.service';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

// The model page's review row asks `getPaged` for `writtenOnly`; this is the filter it adds.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let db: PGlite;
let queryRaw: ReturnType<typeof pgliteRaw>['queryRaw'];

beforeAll(async () => {
  db = new PGlite();
  queryRaw = pgliteRaw(db).queryRaw;
  await db.exec(`
    CREATE TABLE "ResourceReview" (
      id int PRIMARY KEY,
      details text,
      exclude boolean NOT NULL DEFAULT false,
      nsfw boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false
    );
    INSERT INTO "ResourceReview" (id, details, exclude, nsfw, "tosViolation") VALUES
      (1, NULL, false, false, false),
      (2, '', false, false, false),
      (3, '<p></p>', false, false, false),
      (4, '<p>&nbsp; </p>', false, false, false),
      (5, '<p>Works best with the turbo base.</p>', false, false, false),
      (6, 'plain text review', false, false, false),
      (7, '<p>excluded by a moderator</p>', true, false, false),
      (8, '<p>flagged nsfw</p>', false, true, false),
      (9, '<p>tos violation</p>', false, false, true);
  `);
});
afterAll(() => db.close());

const idsMatching = async (filter: Prisma.Sql) => {
  const rows = (await queryRaw`
    SELECT id FROM "ResourceReview" rr WHERE ${filter} ORDER BY id
  `) as { id: number }[];
  return rows.map((r) => r.id);
};

describe('writtenReviewSql', () => {
  it('keeps reviews with text and drops bare thumbs, empty editor HTML and hidden reviews', async () => {
    expect(await idsMatching(writtenReviewSql)).toEqual([5, 6]);
  });
});

describe('getResourceReviewPagedSchema', () => {
  // Without a version, writtenOnly would regex-filter every review of the model in one scan.
  it('rejects writtenOnly without a version', () => {
    expect(getResourceReviewPagedSchema.safeParse({ modelId: 1, writtenOnly: true }).success).toBe(
      false
    );
    expect(
      getResourceReviewPagedSchema.safeParse({ modelId: 1, modelVersionId: 2, writtenOnly: true })
        .success
    ).toBe(true);
  });

  // Without a version, hasImages would probe the images of every reviewer of the model.
  it('rejects hasImages without a version', () => {
    expect(getResourceReviewPagedSchema.safeParse({ modelId: 1, hasImages: true }).success).toBe(
      false
    );
    expect(
      getResourceReviewPagedSchema.safeParse({ modelId: 1, modelVersionId: 2, hasImages: true })
        .success
    ).toBe(true);
  });

  // Every caller that omits the level gets the default, so it must mean "no restriction".
  it('defaults browsingLevel to every level and rejects out-of-range or fractional ones', () => {
    const parse = (browsingLevel?: number) =>
      getResourceReviewPagedSchema.safeParse({ modelId: 1, browsingLevel });
    expect(getResourceReviewPagedSchema.parse({ modelId: 1 }).browsingLevel).toBe(
      allBrowsingLevelsFlag
    );
    expect(parse(allBrowsingLevelsFlag).success).toBe(true);
    expect(parse(allBrowsingLevelsFlag + 1).success).toBe(false);
    expect(parse(1.5).success).toBe(false);
    expect(parse(-1).success).toBe(false);
  });

  // The page's SSR safeParse 404s on a failed parse, so an oversized limit must clamp, not fail.
  it('clamps limit to 50 and defaults it to 20', () => {
    const limitOf = (limit?: number) =>
      getResourceReviewPagedSchema.parse({ modelId: 1, limit }).limit;
    expect(limitOf(51)).toBe(50);
    expect(limitOf(200)).toBe(50);
    expect(limitOf(50)).toBe(50);
    expect(limitOf()).toBe(20);
    expect(getResourceReviewPagedSchema.safeParse({ modelId: 1, limit: 0 }).success).toBe(false);
  });
});
