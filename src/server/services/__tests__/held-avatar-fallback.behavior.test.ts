import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anyImageHeldForReview, clearHeldUserImages } from '~/server/services/held-image-keys';
import { fallbackUserImageColumn } from '~/server/services/profile-picture.sql';

let pg: PGlite;
const db = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return pg.query(sql.text, sql.values as unknown[]).then((r) => r.rows);
  },
} as never;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, url text, "needsReview" text);
    CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int, image text);
    INSERT INTO "Image" VALUES
      (1, 'key-csam', 'csam'), (2, 'key-minor', 'minor'), (3, 'key-poi', 'poi'), (4, 'key-ok', NULL),
      (5, 'KEY-UPPER', 'csam');
    INSERT INTO "User" VALUES
      (1, 1, 'https://cdn.example/KEY-CSAM/width=96'),
      (2, 2, 'key%2dminor'),
      (3, 1, 'legacy'),
      (4, 3, 'key-poi'),
      (5, 4, 'key-ok'),
      (6, NULL, 'key-csam'),
      (7, 2, NULL);
  `);
});
afterAll(() => pg.close());

describe('fallbackUserImageColumn', () => {
  it('nulls a User.image naming its held profile picture, and keeps every other', async () => {
    const { rows } = await pg.query<{ id: number; image: string | null }>(
      `SELECT u.id, ${fallbackUserImageColumn} AS image FROM "User" u ORDER BY u.id`
    );
    expect(rows.map((row) => row.image)).toEqual([
      null,
      null,
      'legacy',
      'key-poi',
      'key-ok',
      'key-csam',
      null,
    ]);
  });
});

describe('clearHeldUserImages', () => {
  it('clears only a User.image naming its held profile picture, among the users given', async () => {
    await pg.exec(`
      INSERT INTO "User" VALUES (8, 1, 'key-csam');
    `);
    expect((await clearHeldUserImages(db, [1, 2, 3, 4, 5, 6, 7])).sort()).toEqual([1, 2]);
    const { rows } = await pg.query<{ id: number; image: string | null }>(
      `SELECT id, image FROM "User" ORDER BY id`
    );
    expect(rows.map((row) => row.image)).toEqual([
      null,
      null,
      'legacy',
      'key-poi',
      'key-ok',
      'key-csam',
      null,
      'key-csam',
    ]);
    expect(await clearHeldUserImages(db, [])).toEqual([]);
  });
});

describe('anyImageHeldForReview', () => {
  it('is true only for a key stored on an image held csam or minor', async () => {
    expect(await anyImageHeldForReview(db, ['key-csam'])).toBe(true);
    expect(await anyImageHeldForReview(db, ['nope', 'key-minor'])).toBe(true);
    expect(await anyImageHeldForReview(db, ['key-upper'])).toBe(true);
    expect(await anyImageHeldForReview(db, ['key-poi', 'key-ok', 'nope'])).toBe(false);
    expect(await anyImageHeldForReview(db, [])).toBe(false);
  });
});
