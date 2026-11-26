import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ArticleSort } from '~/server/common/enums';
import { getArticles } from '~/server/services/article.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

/**
 * `addToShowcaseSection` lets an owner add a Pending (not yet scanned) article to a showcase
 * section, relying on the section's feed (CustomShowcaseSection: ids + username) to show it to
 * nobody else until its scan clears. If this test fails, that add path must refuse unscanned
 * articles instead.
 */

const AUTHOR = 1;
const VISITOR = 2;
const PENDING = 1;
const SCANNED = 2;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published', 'Unpublished');
    CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned');
    CREATE TYPE "MetricTimeframe" AS ENUM ('Day', 'Week', 'Month', 'Year', 'AllTime');
    CREATE TABLE "User" (id int PRIMARY KEY, username text, "deletedAt" timestamp, image text,
      "profilePictureId" int);
    CREATE TABLE "Image" (id int PRIMARY KEY, ingestion text, "needsReview" text, "postId" int,
      "nsfwLevel" int NOT NULL DEFAULT 1, url text, "blockedFor" text, "userId" int);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Model" (id int PRIMARY KEY, mode text, minor boolean NOT NULL DEFAULT false,
      "sfwOnly" boolean NOT NULL DEFAULT false, "gallerySettings" jsonb);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb);
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


    INSERT INTO "User" (id, username) VALUES (${AUTHOR}, 'author'), (${VISITOR}, 'visitor');
    INSERT INTO "Article" (id, title, "publishedAt", "nsfwLevel", "userId", status, ingestion,
      availability)
    VALUES (${PENDING}, 'fresh', now() - interval '1 hour', 1, ${AUTHOR}, 'Published', 'Pending',
      'Public'),
      (${SCANNED}, 'old', now() - interval '1 day', 1, ${AUTHOR}, 'Published', 'Scanned', 'Public');
  `);
});
afterAll(() => pg.close());

let rows: { id: number }[];
// Runs the feed query against PGlite and stops: which rows it selects is the whole question.
beforeEach(() => {
  rows = [];
  dbMock.dbRead.user.findUnique.mockResolvedValue({ id: AUTHOR } as never);
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const q = Prisma.sql(strings, ...(values as never[]));
    ({ rows } = await pg.query<{ id: number }>(q.text, q.values as unknown[]));
    throw new Error('query ran');
  }) as never);
});

// The section feed's input (CustomShowcaseSection.tsx ArticleShowcase).
const sectionFeed = async (viewerId?: number) => {
  rows = [];
  let ran = false;
  await getArticles({
    ids: [PENDING, SCANNED],
    username: 'author',
    period: MetricTimeframe.AllTime,
    sort: ArticleSort.Newest,
    limit: 2,
    browsingLevel: 1,
    sessionUser: viewerId ? { id: viewerId } : undefined,
  } as Parameters<typeof getArticles>[0]).catch((e: Error) => {
    if (e.message !== 'query ran') throw e;
    ran = true;
  });
  expect(ran).toBe(true);
  return rows.map((r) => r.id).sort();
};

describe('a showcase section of articles', () => {
  it('hides a Pending article from a visitor and from a signed-out viewer', async () => {
    expect(await sectionFeed(VISITOR)).toEqual([SCANNED]);
    expect(await sectionFeed()).toEqual([SCANNED]);
  });

  it('shows it to its author', async () => {
    expect(await sectionFeed(AUTHOR)).toEqual([PENDING, SCANNED]);
  });

  it('shows it to a visitor once scanned', async () => {
    await pg.exec(`UPDATE "Article" SET ingestion = 'Scanned' WHERE id = ${PENDING}`);
    try {
      expect(await sectionFeed(VISITOR)).toEqual([PENDING, SCANNED]);
    } finally {
      await pg.exec(`UPDATE "Article" SET ingestion = 'Pending' WHERE id = ${PENDING}`);
    }
  });
});
