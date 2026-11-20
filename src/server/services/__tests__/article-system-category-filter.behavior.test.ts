import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { articleExcludedTagsSql, articleTagFilterSql } from '~/server/services/article.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const STORY = 1; // article categories
const GUIDE = 2;
const OFFICIAL = 9; // a tag that is not a category
const CATEGORIES = [STORY, GUIDE];

const SYSTEM_STORY_AUTHOR_GUIDE = 101;
const UNSCANNED_AUTHOR_GUIDE = 102;
const OFFICIAL_ONLY = 103;
const SYSTEM_GUIDE_NO_AUTHOR_PICK = 104;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Article" (id int PRIMARY KEY, "systemCategoryId" int);
    CREATE TABLE "TagsOnArticle" ("articleId" int NOT NULL, "tagId" int NOT NULL);
    INSERT INTO "Article" VALUES
      (${SYSTEM_STORY_AUTHOR_GUIDE}, ${STORY}),
      (${UNSCANNED_AUTHOR_GUIDE}, NULL),
      (${OFFICIAL_ONLY}, NULL),
      (${SYSTEM_GUIDE_NO_AUTHOR_PICK}, ${GUIDE});
    INSERT INTO "TagsOnArticle" VALUES
      (${SYSTEM_STORY_AUTHOR_GUIDE}, ${GUIDE}),
      (${UNSCANNED_AUTHOR_GUIDE}, ${GUIDE}),
      (${OFFICIAL_ONLY}, ${OFFICIAL});
  `);
});

afterAll(() => pg.close());

const ids = async (where: Prisma.Sql) =>
  (
    await pg.query<{ id: number }>(
      `SELECT a.id FROM "Article" a WHERE ${where.text} ORDER BY a.id`,
      [...where.values]
    )
  ).rows.map((r) => r.id);

describe('articleTagFilterSql', () => {
  it("lists an article under its system category, and under its author's pick only when it has none", async () => {
    expect(await ids(articleTagFilterSql([STORY], CATEGORIES))).toEqual([
      SYSTEM_STORY_AUTHOR_GUIDE,
    ]);
    expect(await ids(articleTagFilterSql([GUIDE], CATEGORIES))).toEqual([
      UNSCANNED_AUTHOR_GUIDE,
      SYSTEM_GUIDE_NO_AUTHOR_PICK,
    ]);
  });

  it("matches a tag that is not a category on the author's tags", async () => {
    expect(await ids(articleTagFilterSql([OFFICIAL], CATEGORIES))).toEqual([OFFICIAL_ONLY]);
  });

  it('widens the list when ids are mixed', async () => {
    expect(await ids(articleTagFilterSql([STORY, OFFICIAL], CATEGORIES))).toEqual([
      SYSTEM_STORY_AUTHOR_GUIDE,
      OFFICIAL_ONLY,
    ]);
  });
});

describe('articleExcludedTagsSql', () => {
  it('hides an article whose system category the viewer hides, whatever its author picked', async () => {
    expect(await ids(articleExcludedTagsSql([STORY]))).toEqual([
      UNSCANNED_AUTHOR_GUIDE,
      OFFICIAL_ONLY,
      SYSTEM_GUIDE_NO_AUTHOR_PICK,
    ]);
  });

  it("still hides an article by its author's tags", async () => {
    expect(await ids(articleExcludedTagsSql([GUIDE]))).toEqual([OFFICIAL_ONLY]);
  });

  it('keeps an article with no system category when nothing it carries is hidden', async () => {
    expect(await ids(articleExcludedTagsSql([OFFICIAL]))).toEqual([
      SYSTEM_STORY_AUTHOR_GUIDE,
      UNSCANNED_AUTHOR_GUIDE,
      SYSTEM_GUIDE_NO_AUTHOR_PICK,
    ]);
  });
});
