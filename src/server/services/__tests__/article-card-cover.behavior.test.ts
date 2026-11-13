import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ArticleSort } from '~/server/common/enums';
import {
  articleCardCoverIdSql,
  getArticles,
  getCivitaiNews,
} from '~/server/services/article.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

/**
 * Article cards (the feed and Civitai News) show the cover, else the banner once it is servable:
 * a banner that is unscanned or awaiting review is hidden on the article page, so no card may
 * show it either.
 */

const COVER = 10;
const BANNER = 11;
const BANNER_PENDING = 12;
const BANNER_NEEDS_REVIEW = 13;

const BANNER_ONLY = 1;
const PENDING_BANNER_ONLY = 2;
const FLAGGED_BANNER_ONLY = 3;
const COVER_AND_BANNER = 4;
const NEITHER = 5;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, ingestion text NOT NULL, "needsReview" text);
    CREATE TABLE "Article" (id int PRIMARY KEY, "coverId" int, "bannerId" int);
    INSERT INTO "Image" (id, ingestion, "needsReview") VALUES
      (${COVER}, 'Scanned', NULL),
      (${BANNER}, 'Scanned', NULL),
      (${BANNER_PENDING}, 'Pending', NULL),
      (${BANNER_NEEDS_REVIEW}, 'Scanned', 'minor');
    INSERT INTO "Article" (id, "coverId", "bannerId") VALUES
      (${BANNER_ONLY}, NULL, ${BANNER}),
      (${PENDING_BANNER_ONLY}, NULL, ${BANNER_PENDING}),
      (${FLAGGED_BANNER_ONLY}, NULL, ${BANNER_NEEDS_REVIEW}),
      (${COVER_AND_BANNER}, ${COVER}, ${BANNER}),
      (${NEITHER}, NULL, NULL);
  `);
});
afterAll(() => pg.close());

async function cardCoverId(articleId: number) {
  const q = Prisma.sql`SELECT ${articleCardCoverIdSql} AS "coverId" FROM "Article" a WHERE a.id = ${articleId}`;
  const { rows } = await pg.query<{ coverId: number | null }>(q.text, q.values as unknown[]);
  return rows[0]?.coverId ?? null;
}

describe('article card cover', () => {
  it('gives a banner-only article its banner', async () => {
    expect(await cardCoverId(BANNER_ONLY)).toBe(BANNER);
  });

  it.each([
    ['has not finished scanning', PENDING_BANNER_ONLY],
    ['awaits review', FLAGGED_BANNER_ONLY],
  ])('gives no image when the only banner %s', async (_, id) => {
    expect(await cardCoverId(id)).toBeNull();
  });

  it('prefers the cover over the banner', async () => {
    expect(await cardCoverId(COVER_AND_BANNER)).toBe(COVER);
  });

  it('gives no image when there is neither', async () => {
    expect(await cardCoverId(NEITHER)).toBeNull();
  });
});

describe('article card reads use the card cover', () => {
  const issued: string[] = [];
  // Records the SQL and stops: which cover the query selects is the whole question here.
  function recordQuery(strings: TemplateStringsArray, ...values: unknown[]) {
    issued.push(Prisma.sql(strings, ...(values as never[])).text);
    throw new Error('query issued');
  }

  beforeEach(() => {
    issued.length = 0;
    dbMock.dbRead.$queryRaw.mockImplementation(recordQuery as never);
  });

  it('the article feed selects the card cover as "coverId"', async () => {
    await getArticles({
      limit: 10,
      sort: ArticleSort.Newest,
      period: MetricTimeframe.AllTime,
      periodMode: 'published',
      browsingLevel: 1,
    } as Parameters<typeof getArticles>[0]).catch(() => undefined);

    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain(`${articleCardCoverIdSql.text} AS "coverId"`);
  });

  it('Civitai News selects the card cover as "coverId"', async () => {
    await getCivitaiNews().catch(() => undefined);

    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain(`${articleCardCoverIdSql.text} AS "coverId"`);
  });
});
