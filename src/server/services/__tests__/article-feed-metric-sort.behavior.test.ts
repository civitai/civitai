import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ArticleSort } from '~/server/common/enums';
import { getArticles } from '~/server/services/article.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

/**
 * The "Most ..." article sorts for a period shorter than AllTime must order by the article's
 * counts. Only AllTime metric rows are kept up to date, so the per-period rank columns are NULL
 * for every recent article; this seeds that shape.
 */

// Ids deliberately disagree with the counts, so an id-ordered feed cannot pass.
const FOUR_BOOKMARKS = 1;
const TEN_BOOKMARKS = 2;
const NO_BOOKMARKS = 3;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published', 'Unpublished');
    CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned');
    CREATE TYPE "MetricTimeframe" AS ENUM ('Day', 'Week', 'Month', 'Year', 'AllTime');
    CREATE TABLE "User" (id int PRIMARY KEY, username text, "deletedAt" timestamp, image text,
      "profilePictureId" int);
    CREATE TABLE "Image" (id int PRIMARY KEY, ingestion text, "needsReview" text);
    CREATE TABLE "Article" (id int PRIMARY KEY, cover text, "coverId" int, "bannerId" int,
      title text, "publishedAt" timestamp, "nsfwLevel" int, "userNsfwLevel" int, "userId" int,
      "createdAt" timestamp DEFAULT now(), "updatedAt" timestamp DEFAULT now(), unlisted boolean,
      availability text, status "ArticleStatus", ingestion "ArticleIngestionStatus",
      "isOfficial" boolean);
    CREATE TABLE "Tag" (id int PRIMARY KEY, name text, "isCategory" boolean);
    CREATE TABLE "TagsOnArticle" ("articleId" int, "tagId" int);
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, data jsonb, type text, source text, name text,
      "leaderboardId" text, "leaderboardPosition" int);
    CREATE TABLE "UserCosmetic" ("userId" int, "cosmeticId" int, data jsonb, "equippedAt" timestamp,
      "equippedToId" int);
    CREATE TABLE "ArticleMetric" ("articleId" int, timeframe "MetricTimeframe", "collectedCount" int DEFAULT 0,
      "commentCount" int DEFAULT 0, "heartCount" int DEFAULT 0, "likeCount" int DEFAULT 0,
      "dislikeCount" int DEFAULT 0, "laughCount" int DEFAULT 0, "cryCount" int DEFAULT 0,
      PRIMARY KEY ("articleId", timeframe));
    CREATE TABLE "ArticleRank" ("articleId" int PRIMARY KEY,
      "collectedCountMonthRank" int, "collectedCountAllTimeRank" int,
      "commentCountMonthRank" int, "commentCountAllTimeRank" int,
      "reactionCountMonthRank" int, "reactionCountAllTimeRank" int);

    INSERT INTO "User" (id, username) VALUES (1, 'author');
    INSERT INTO "Article" (id, title, "publishedAt", "nsfwLevel", "userId", status, ingestion)
    SELECT id, 'a' || id, now() - interval '1 day', 1, 1, 'Published', 'Scanned'
    FROM generate_series(1, 3) id;

    INSERT INTO "ArticleMetric"
      ("articleId", timeframe, "collectedCount", "commentCount", "likeCount", "heartCount") VALUES
      (${FOUR_BOOKMARKS}, 'AllTime', 4, 4, 2, 2),
      (${TEN_BOOKMARKS}, 'AllTime', 10, 10, 5, 5),
      (${NO_BOOKMARKS}, 'AllTime', 0, 0, 0, 0);
    -- The rank rows the hourly refresh writes: Month columns NULL. The AllTime ranks are
    -- deliberately stale (they predate the latest bookmarks) to show AllTime still reads them.
    INSERT INTO "ArticleRank" ("articleId", "collectedCountAllTimeRank", "commentCountAllTimeRank",
      "reactionCountAllTimeRank") VALUES
      (${NO_BOOKMARKS}, 1, 1, 1), (${FOUR_BOOKMARKS}, 2, 2, 2), (${TEN_BOOKMARKS}, 3, 3, 3);
  `);
});
afterAll(() => pg.close());

type Row = { id: number; cursorV: number };
let pages: Row[][];

// Runs the feed query against PGlite and stops: the order and the cursor are the whole question,
// and stopping keeps the rest of `getArticles` (stats, images, cosmetics) out of the test.
beforeEach(() => {
  pages = [];
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const q = Prisma.sql(strings, ...(values as never[]));
    const { rows } = await pg.query<Row>(q.text, q.values as unknown[]);
    pages.push(rows);
    throw new Error('query ran');
  }) as never);
});

async function page(
  sort: ArticleSort,
  period: MetricTimeframe,
  limit: number,
  cursor?: { v: number; id: number }
) {
  await getArticles({
    limit,
    sort,
    period,
    periodMode: 'published',
    browsingLevel: 1,
    cursor,
  } as Parameters<typeof getArticles>[0]).catch((e: Error) => {
    if (e.message !== 'query ran') throw e;
  });
  const rows = pages.at(-1)!;
  // getArticles takes limit + 1 rows; the extra one becomes the next cursor.
  const next = rows[limit];
  return {
    ids: rows.slice(0, limit).map((r) => r.id),
    next: next ? { v: Number(next.cursorV), id: next.id } : undefined,
  };
}

async function feed(sort: ArticleSort, period: MetricTimeframe) {
  const ids: number[] = [];
  let cursor: { v: number; id: number } | undefined;
  do {
    const p = await page(sort, period, 1, cursor);
    ids.push(...p.ids);
    cursor = p.next;
  } while (cursor && ids.length < 10);
  return ids;
}

describe('article feed "Most ..." sorts within a period', () => {
  it.each([ArticleSort.MostBookmarks, ArticleSort.MostCollected])(
    '%s orders the month by bookmark count, across pages',
    async (sort) => {
      expect(await feed(sort, MetricTimeframe.Month)).toEqual([
        TEN_BOOKMARKS,
        FOUR_BOOKMARKS,
        NO_BOOKMARKS,
      ]);
    }
  );

  it.each([ArticleSort.MostComments, ArticleSort.MostReactions])(
    '%s orders the month by its count',
    async (sort) => {
      expect(await feed(sort, MetricTimeframe.Month)).toEqual([
        TEN_BOOKMARKS,
        FOUR_BOOKMARKS,
        NO_BOOKMARKS,
      ]);
    }
  );

  it('All Time keeps the precomputed rank', async () => {
    expect(await feed(ArticleSort.MostBookmarks, MetricTimeframe.AllTime)).toEqual([
      NO_BOOKMARKS,
      FOUR_BOOKMARKS,
      TEN_BOOKMARKS,
    ]);
  });
});
