import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anyImageHeldOrBlocked, clearHeldUserImages } from '~/server/services/held-image-keys';
import { fallbackUserImageColumn } from '~/server/services/profile-picture.sql';

let pg: PGlite;
const db = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return pg.query(sql.text, sql.values as unknown[]).then((r) => r.rows);
  },
  $queryRawUnsafe: (text: string, ...values: unknown[]) =>
    pg.query(text, values).then((r) => r.rows),
} as never;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int, url text, "needsReview" text, ingestion text NOT NULL DEFAULT 'Scanned',
      "nsfwLevel" int NOT NULL DEFAULT 1, "blockedFor" text
    );
    CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int, image text, meta jsonb);
    INSERT INTO "Image" (id, url, "needsReview") VALUES
      (1, 'key-csam', 'csam'), (2, 'key-minor', 'minor'), (3, 'key-poi', 'poi'), (4, 'key-ok', NULL),
      (5, 'KEY-UPPER', 'csam');
    INSERT INTO "User" (id, "profilePictureId", image, meta) VALUES
      (1, 1, 'https://cdn.example/KEY-CSAM/width=96', '{"keep": true}'),
      (2, 2, 'key%2dminor', NULL),
      (3, 1, 'legacy', '{}'),
      (4, 3, 'key-poi', '{}'),
      (5, 4, 'key-ok', '{}'),
      (6, NULL, 'key-csam', '{}'),
      (7, 2, NULL, '{}');
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
      INSERT INTO "User" VALUES (8, 1, 'key-csam', '"a string meta"');
    `);
    expect((await clearHeldUserImages(db, [1, 2, 3, 4, 5, 6, 7])).sort()).toEqual([1, 2, 3, 7]);
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
    // The cleared ones are marked with the picture only, never the value; other meta is kept.
    const meta = await pg.query<{ id: number; meta: unknown }>(
      `SELECT id, meta FROM "User" WHERE id IN (1, 2, 3) ORDER BY id`
    );
    expect(meta.rows).toEqual([
      { id: 1, meta: { keep: true, heldImageCleared: { pictureId: 1 } } },
      { id: 2, meta: { heldImageCleared: { pictureId: 2 } } },
      { id: 3, meta: {} },
    ]);
    // A non-object meta takes no marker but is still cleared.
    await clearHeldUserImages(db, [8]);
    const eight = await pg.query<{ image: string | null; meta: unknown }>(
      `SELECT image, meta FROM "User" WHERE id = 8`
    );
    expect(eight.rows[0]).toEqual({ image: null, meta: 'a string meta' });
    expect(await clearHeldUserImages(db, [])).toEqual([]);
  });
});

describe('anyImageHeldOrBlocked', () => {
  it('is true for a key stored on an image held csam or minor, and false for an unheld one', async () => {
    expect(await anyImageHeldOrBlocked(db, ['key-csam'])).toBe(true);
    expect(await anyImageHeldOrBlocked(db, ['nope', 'key-minor'])).toBe(true);
    expect(await anyImageHeldOrBlocked(db, ['key-upper'])).toBe(true);
    expect(await anyImageHeldOrBlocked(db, ['key-poi', 'key-ok', 'nope'])).toBe(false);
    expect(await anyImageHeldOrBlocked(db, [])).toBe(false);
  });
});

describe('a blocked picture', () => {
  it('is refused as an avatar url, while a clean image of the same owner is not', async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, "userId", url, ingestion, "nsfwLevel", "blockedFor") VALUES
        (20, 20, 'key-blocked', 'Blocked', 1, NULL),
        (21, 20, 'key-level', 'Scanned', 32, NULL),
        (22, 20, 'key-reason', 'Rescan', 1, 'tos'),
        (23, 20, 'key-clean', 'Scanned', 1, NULL);
    `);
    for (const key of ['key-blocked', 'key-level', 'key-reason'])
      expect(await anyImageHeldOrBlocked(db, [key])).toBe(true);
    expect(await anyImageHeldOrBlocked(db, ['key-clean'])).toBe(false);
  });

  it('drops out of the User.image fallback when User.image names it', async () => {
    await pg.exec(`
      INSERT INTO "User" (id, "profilePictureId", image, meta) VALUES
        (20, 20, 'https://cdn.example/key-blocked/width=96', '{}'),
        (21, 22, 'key-reason', '{}'),
        (22, 20, 'another-value', '{}'),
        (23, 23, 'key-clean', '{}');
    `);
    const { rows } = await pg.query<{ image: string | null }>(
      `SELECT ${fallbackUserImageColumn} AS image FROM "User" u WHERE u.id >= 20 ORDER BY u.id`
    );
    expect(rows.map((row) => row.image)).toEqual([null, null, 'another-value', 'key-clean']);
  });
});
