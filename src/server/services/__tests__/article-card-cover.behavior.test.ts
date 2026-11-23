import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ArticleSort } from '~/server/common/enums';
import { getModelWithheldImageIds } from '~/server/services/collection-cover-visibility';
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
const COVER_ON_TAKEN_DOWN = 6;
const COVER_ABOVE_GALLERY = 7;
const BANNER_ON_TAKEN_DOWN = 8;
const COVER_ON_LIVE = 9;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, mode text, minor boolean NOT NULL DEFAULT false,
      "sfwOnly" boolean NOT NULL DEFAULT false, "gallerySettings" jsonb
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, ingestion text NOT NULL, "needsReview" text, "postId" int,
      "nsfwLevel" int NOT NULL DEFAULT 1
    );
    -- Model 50 is taken down, 51 is minor with a PG gallery level, 52 is live and unflagged.
    INSERT INTO "Model" (id, mode, minor, "gallerySettings") VALUES
      (50, 'TakenDown', false, NULL), (51, NULL, true, '{"level": 1}'), (52, NULL, false, NULL);
    INSERT INTO "ModelVersion" VALUES (60, 50), (61, 51), (62, 52);
    INSERT INTO "Post" VALUES (70, 60), (71, 61), (72, 62);
    -- 20 on the taken-down model, 21 PG-13 on the minor model, 22 a banner on the taken-down
    -- model, 23 PG-13 on the live model.
    INSERT INTO "Image" (id, ingestion, "postId", "nsfwLevel") VALUES
      (20, 'Scanned', 70, 1), (21, 'Scanned', 71, 2), (22, 'Scanned', 70, 1), (23, 'Scanned', 72, 2);
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
      (${NEITHER}, NULL, NULL),
      (${COVER_ON_TAKEN_DOWN}, 20, ${BANNER}),
      (${COVER_ABOVE_GALLERY}, 21, NULL),
      (${BANNER_ON_TAKEN_DOWN}, NULL, 22),
      (${COVER_ON_LIVE}, 23, NULL);
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

  it.each([
    ['its cover is on a taken-down model, without falling back to the banner', COVER_ON_TAKEN_DOWN],
    ["its cover is above its minor model's gallery level", COVER_ABOVE_GALLERY],
    ['its only banner is on a taken-down model', BANNER_ON_TAKEN_DOWN],
  ])('🔴 gives no image when %s', async (_, id) => {
    expect(await cardCoverId(id)).toBeNull();
  });

  it('keeps a cover on a live, unflagged model', async () => {
    expect(await cardCoverId(COVER_ON_LIVE)).toBe(23);
  });

  it('gives no image when there is neither', async () => {
    expect(await cardCoverId(NEITHER)).toBeNull();
  });
});

describe('getModelWithheldImageIds', () => {
  it('names the images on a taken-down model or above a held gallery level, and no other', async () => {
    const raw = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...(values as never[]));
      return pg.query(q.text, q.values as unknown[]).then((r) => r.rows);
    };
    const withheld = await getModelWithheldImageIds([10, 20, 21, 22, 23], {
      $queryRaw: raw,
    } as never);
    expect([...withheld].sort()).toEqual([20, 21, 22]);
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

  it('Civitai News follows the article availability rule', async () => {
    await getCivitaiNews().catch(() => undefined);

    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain(`AND a.availability != 'Private'`);
  });

  it('Civitai News selects the card cover as "coverId"', async () => {
    await getCivitaiNews().catch(() => undefined);

    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain(`${articleCardCoverIdSql.text} AS "coverId"`);
  });
});
