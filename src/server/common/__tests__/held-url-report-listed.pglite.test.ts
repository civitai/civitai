import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reportListedUrlSql } from '@civitai/shared/held-url';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Which urls `reportListedUrlSql` reads as carrying reported bytes, run on an in-process Postgres. Every
 * leg has a url it alone answers for, and an unlisted url answers false, so a leg that stops matching or
 * one that matches everything both fail here.
 */

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL, "pHash" bigint);
    CREATE TABLE "ImageCdnModeratorDelete" ("imageId" int PRIMARY KEY, url text NOT NULL);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, images jsonb);
    CREATE TABLE "Probe" (url text PRIMARY KEY, "imageId" int);

    INSERT INTO "Image" (id, url, "pHash") VALUES
      (1, 'u-listed', NULL),        -- listed as an object id
      (2, 'u-listed-text', NULL),   -- listed as a bare string id
      (3, 'u-phash', 900),          -- listed; its pHash is shared by image 4 on another url
      (4, 'u-phash-copy', 900),
      (5, 'u-clean', 901),
      (6, 'u-self', NULL),          -- listed; probed with itself as the exception
      (7, 'u-self', NULL),          -- unlisted, on 6's url
      (8, 'u-other-self', NULL);    -- listed; probed with itself as the exception, alone on its url
    INSERT INTO "ImageCdnModeratorDelete" ("imageId", url) VALUES
      (50, 'u-deleted'),            -- listed after the row was deleted
      (51, 'u-deleted-unlisted');
    INSERT INTO "CsamReport" (images) VALUES
      ('[{"id": 1}, "2", {"id": 3}]'),
      ('[{"id": "50"}, {"id": "not-a-number"}, {"id": 6}, {"id": 8}]'),
      ('{"id": 5}');                -- not an array: lists nothing
    INSERT INTO "Probe" (url, "imageId") VALUES
      ('u-listed', NULL), ('u-listed-text', NULL), ('u-phash', NULL), ('u-phash-copy', NULL),
      ('u-clean', NULL), ('u-deleted', NULL), ('u-deleted-unlisted', NULL), ('u-none', NULL),
      ('u-self', 7), ('u-other-self', 8);
  `);
});
afterAll(() => db?.close());

const listed = async (sql: string) =>
  (
    await db.query<{ url: string }>(`SELECT url FROM "Probe" pr WHERE ${sql} ORDER BY url`)
  ).rows.map((row) => row.url);

const LISTED = ['u-deleted', 'u-listed', 'u-listed-text', 'u-phash', 'u-phash-copy', 'u-self'];

describe('reportListedUrlSql', () => {
  it('reads a url as listed by a listed row on it, a listed delete on it, or a listed pHash', async () => {
    expect(await listed(reportListedUrlSql('pr."url"'))).toEqual(
      [...LISTED, 'u-other-self'].sort()
    );
  });

  it("leaves out the excepted image's own listing on its url", async () => {
    // 'u-self' stays listed through image 6; 'u-other-self' is listed only by the excepted image 8.
    expect(
      await listed(
        `pr."imageId" IS NOT NULL AND ${reportListedUrlSql('pr."url"', {
          exceptImageId: 'pr."imageId"',
        })}`
      )
    ).toEqual(['u-self']);
  });
});
