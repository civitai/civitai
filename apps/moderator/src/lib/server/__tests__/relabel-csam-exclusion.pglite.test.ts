import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { servableImageKeys } from '../relabel.service';
import { csamExcludedImageIds } from '../relabel-csam-exclusion';
import { pgliteDialect } from './abuse-detection-pglite.harness';

// Stand-ins for the five main-database tables the query reads, cut to the columns it touches.
const TABLES = `
CREATE TABLE "Image" (
  id int PRIMARY KEY, "userId" int NOT NULL, "blockedFor" text,
  url text NOT NULL DEFAULT 'key', type text NOT NULL DEFAULT 'image'
);
CREATE TABLE "Report" (id int PRIMARY KEY, reason text NOT NULL);
CREATE TABLE "ImageReport" ("reportId" int NOT NULL, "imageId" int NOT NULL);
CREATE TABLE "UserReport" ("reportId" int NOT NULL, "userId" int NOT NULL);
CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb NOT NULL DEFAULT '[]');
`;

let pg: PGlite;
let db: Kysely<Record<string, never>>;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(TABLES);
  db = new Kysely({ dialect: pgliteDialect(pg) });
}, 60_000);

beforeEach(async () => {
  await pg.exec('TRUNCATE "Image", "Report", "ImageReport", "UserReport", "CsamReport"');
  // Image 1: clean, owner 10. Image 2: clean, owner 20. Used as the "must survive" controls.
  await pg.exec(
    `INSERT INTO "Image" (id, "userId", "blockedFor") VALUES (1, 10, NULL), (2, 20, 'moderated')`
  );
});

const excluded = async (ids: number[]) =>
  (await csamExcludedImageIds(ids).execute(db)).rows.map((r) => r.id).sort((a, b) => a - b);

// Decision: an image is out of the relabel set if ANY CSAM signal touches it or its owner. No one
// signal is complete (a user report files no CsamReport; a moderator removal overwrites
// blockedFor), so removing one of these checks re-admits real cases.
describe('csamExcludedImageIds', () => {
  it('keeps images no CSAM signal touches', async () => {
    expect(await excluded([1, 2])).toEqual([]);
  });

  it('excludes an image listed in a CsamReport, in either stored shape', async () => {
    await pg.exec(`INSERT INTO "CsamReport" (images) VALUES ('[{"id": 1}]'), ('[2]')`);
    expect(await excluded([1, 2])).toEqual([1, 2]);
  });

  it('excludes an image a listed report covers even when its row is gone', async () => {
    await pg.exec(`INSERT INTO "CsamReport" (images) VALUES ('[99]')`);
    expect(await excluded([99, 1])).toEqual([99]);
  });

  it('excludes an image blocked for CSAM', async () => {
    await pg.exec(`INSERT INTO "Image" (id, "userId", "blockedFor") VALUES (3, 30, 'CSAM')`);
    expect(await excluded([1, 3])).toEqual([3]);
  });

  it('excludes an image with a CSAM user report after a moderator removal overwrote blockedFor', async () => {
    await pg.exec(
      `INSERT INTO "Report" VALUES (500, 'CSAM'); INSERT INTO "ImageReport" VALUES (500, 2)`
    );
    expect(await excluded([1, 2])).toEqual([2]);
  });

  it('ignores a non-CSAM report', async () => {
    await pg.exec(
      `INSERT INTO "Report" VALUES (501, 'TOSViolation'); INSERT INTO "ImageReport" VALUES (501, 1)`
    );
    expect(await excluded([1])).toEqual([]);
  });

  it('excludes every image of an owner with a CsamReport', async () => {
    await pg.exec(`INSERT INTO "CsamReport" ("userId") VALUES (10)`);
    expect(await excluded([1, 2])).toEqual([1]);
  });

  it('excludes every image of an owner reported to us for CSAM as a user', async () => {
    await pg.exec(
      `INSERT INTO "Report" VALUES (503, 'CSAM'); INSERT INTO "UserReport" VALUES (503, 20)`
    );
    expect(await excluded([1, 2])).toEqual([2]);
  });

  it('excludes every image of an owner with any image blocked for CSAM', async () => {
    await pg.exec(`INSERT INTO "Image" (id, "userId", "blockedFor") VALUES (4, 20, 'CSAM')`);
    expect(await excluded([1, 2])).toEqual([2]);
  });
});

// Decision: a CsamReport whose `images` is not an array makes the query THROW rather than skip that
// report. Failing closed means the page shows nothing and the build stops, instead of sampling an
// image the report may cover. Do not add a jsonb_typeof guard that silently drops such rows.
describe('a CsamReport with a non-array image list', () => {
  it.each(['{"id": 1}', 'null'])(
    'stops the query instead of skipping the report (%s)',
    async (v) => {
      await pg.exec(`INSERT INTO "CsamReport" (images) VALUES ('${v}')`);
      await expect(excluded([1])).rejects.toThrow();
    }
  );
});

describe('servableImageKeys', () => {
  it('re-checks at serve time: an image reported after it was sampled is no longer shown', async () => {
    const serve = async () => [...(await servableImageKeys(db as never, [1, 2])).keys()].sort();
    expect(await serve()).toEqual([1, 2]);
    await pg.exec(
      `INSERT INTO "Report" VALUES (502, 'CSAM'); INSERT INTO "ImageReport" VALUES (502, 1)`
    );
    expect(await serve()).toEqual([2]);
  });

  it('drops an image that is gone or is not a still image', async () => {
    await pg.exec(`UPDATE "Image" SET type = 'video' WHERE id = 2`);
    expect([...(await servableImageKeys(db as never, [1, 2, 77])).keys()]).toEqual([1]);
  });
});
