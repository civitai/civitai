import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { holdSearchShowcase, withoutListedImages } from '~/server/search-index/models.search-index';
import {
  getReportListedHiddenImageIds,
  SIGNED_OUT_REPORT_LISTED,
} from '~/server/services/report-listed-visibility';

const reportListedImageIds = (ids: number[], db: never) =>
  getReportListedHiddenImageIds(ids, SIGNED_OUT_REPORT_LISTED, db);

// A model's search document is shared by every searcher: an image listed on a CSAM report, whatever
// the report's state, is left out of it. The lookup runs on Postgres.

const LISTED = 1;
const LISTED_BARE_ID = 2;
const CLEAN = 3;

let pg: PGlite;
const db = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return pg.query(flat.text, flat.values as unknown[]).then((r) => r.rows);
  },
} as never;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, images jsonb);
    INSERT INTO "Image" (id) VALUES (${LISTED}), (${LISTED_BARE_ID}), (${CLEAN});
    INSERT INTO "CsamReport" (images) VALUES
      ('[{"id": ${LISTED}}]'), ('[${LISTED_BARE_ID}]'), ('"not a list"'), (NULL);
  `);
});
afterAll(() => pg.close());

describe('the images listed on a CSAM report', () => {
  it('are found whether the report lists an object or a bare id', async () => {
    expect([...(await reportListedImageIds([LISTED, LISTED_BARE_ID, CLEAN], db))].sort()).toEqual([
      LISTED,
      LISTED_BARE_ID,
    ]);
  });

  it('leave out an image no report lists (control)', async () => {
    expect([...(await reportListedImageIds([CLEAN], db))]).toEqual([]);
  });

  it('read nothing for no images', async () => {
    expect([...(await reportListedImageIds([], db))]).toEqual([]);
  });
});

describe("a model's showcase in its search document", () => {
  const byVersion = {
    10: { images: [{ id: LISTED }, { id: CLEAN }] },
    20: { images: [{ id: LISTED_BARE_ID }] },
  };

  it('drops the listed images from every version', () => {
    expect(withoutListedImages(byVersion, new Set([LISTED, LISTED_BARE_ID]))).toEqual({
      10: { images: [{ id: CLEAN }] },
      20: { images: [] },
    });
  });

  it('keeps every image when none is listed (control)', () => {
    expect(withoutListedImages(byVersion, new Set())).toEqual(byVersion);
  });
});

describe('the showcase the models index builds', () => {
  it('leaves out an image a CSAM report lists, and keeps the others', async () => {
    // The listed-ids lookup is the only read of "Image" by id here.
    dbMock.dbRead.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Image" i') ? [{ id: LISTED }] : []) as never);
    const built = await holdSearchShowcase(
      {
        10: {
          images: [
            { id: LISTED, nsfwLevel: 1 },
            { id: CLEAN, nsfwLevel: 1 },
          ],
        },
      },
      [{ id: 100, minor: false, sfwOnly: false, modelVersions: [{ id: 10 }] }]
    );
    expect(built[10].images.map((image) => image.id)).toEqual([CLEAN]);
  });
});
