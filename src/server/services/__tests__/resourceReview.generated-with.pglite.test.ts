import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/** Who counts as having generated with a version, against PGlite. Ids are invented. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { hasGeneratedWithVersion } = await import('~/server/services/resourceReview.service');

const VERSION = 20;
const OTHER_VERSION = 21;
const USER = 7;
const SOMEONE_ELSE = 8;
const ON_SITE = { civitaiResources: [{ modelVersionId: VERSION }] };

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, meta jsonb);
    CREATE TABLE "ImageResourceNew" (
      "imageId" int NOT NULL,
      "modelVersionId" int NOT NULL,
      PRIMARY KEY ("imageId", "modelVersionId")
    );
  `);
});
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec('TRUNCATE "Image", "ImageResourceNew";');
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return (await pg.query(sql.text, sql.values as unknown[])).rows;
  }) as never);
});

const image = async (id: number, userId: number, meta: unknown, versionId = VERSION) => {
  await pg.query('INSERT INTO "Image" (id, "userId", meta) VALUES ($1, $2, $3)', [
    id,
    userId,
    JSON.stringify(meta),
  ]);
  await pg.query('INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId") VALUES ($1, $2)', [
    id,
    versionId,
  ]);
};

describe('hasGeneratedWithVersion', () => {
  it('is true for the user own on-site image made with the version', async () => {
    await image(1, USER, ON_SITE);
    expect(await hasGeneratedWithVersion({ userId: USER, modelVersionId: VERSION })).toBe(true);
  });

  it('is false for someone else image, another version, or an image made off-site', async () => {
    await image(1, SOMEONE_ELSE, ON_SITE);
    await image(2, USER, ON_SITE, OTHER_VERSION);
    // A Version key marks metadata written by an external tool.
    await image(3, USER, { ...ON_SITE, Version: 'ComfyUI' });
    expect(await hasGeneratedWithVersion({ userId: USER, modelVersionId: VERSION })).toBe(false);
  });
});
