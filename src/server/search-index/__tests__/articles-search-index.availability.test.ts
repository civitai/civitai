import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { Prisma } from '@prisma/client';
import { articleSearchEligibleWhere } from '~/server/search-index/articles.search-index';
import { CLEANUP_INDEXES } from '~/server/meilisearch/cleanup';

const SCHEMA = `
  CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published', 'Unpublished', 'UnpublishedViolation', 'Processing');
  CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'Rescan');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TABLE "Article" (
    id int PRIMARY KEY,
    "publishedAt" timestamp(3),
    status "ArticleStatus" NOT NULL,
    ingestion "ArticleIngestionStatus" NOT NULL,
    "tosViolation" boolean NOT NULL,
    availability "Availability" NOT NULL
  );
  INSERT INTO "Article" VALUES
    (1, now(), 'Published', 'Scanned', false, 'Public'),
    (2, now(), 'Published', 'Scanned', false, 'EarlyAccess'),
    (3, now(), 'Published', 'Scanned', false, 'Private'),
    (4, now(), 'Published', 'Scanned', false, 'Unsearchable');
`;

describe('articles search index', () => {
  let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
  beforeAll(async () => {
    harness = await startPglitePrisma(SCHEMA);
  }, 60_000);
  afterAll(() => harness?.stop());

  it('follows the article availability rule for search', async () => {
    const rows = await harness.prisma.article.findMany({
      where: articleSearchEligibleWhere,
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('cleanup keeps the same articles', async () => {
    const articles = CLEANUP_INDEXES.find((index) => index.key === 'articles')!;
    const rows = await harness.prisma.$queryRaw<{ id: number }[]>(
      Prisma.sql`SELECT a.id FROM "Article" a WHERE ${articles.where([1, 2, 3, 4])} ORDER BY a.id`
    );
    expect(rows.map((r) => Number(r.id))).toEqual([1, 2]);
  });
});
