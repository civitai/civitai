import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anyImageHeldOrBlocked, clearHeldUserImages } from '~/server/services/held-image-keys';
import {
  fallbackUserImageColumn,
  fallbackUserImageColumnOf,
} from '~/server/services/profile-picture.sql';

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

describe('fallbackUserImageColumnOf', () => {
  it('is the same column over the default alias', () => {
    expect(fallbackUserImageColumnOf('u')).toBe(fallbackUserImageColumn);
  });

  it('applies the rule over another alias for User', async () => {
    const { rows } = await pg.query<{ image: string | null }>(
      `SELECT ${fallbackUserImageColumnOf(
        'ju'
      )} AS image FROM "User" ju WHERE ju.id <= 7 ORDER BY ju.id`
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

describe('fallbackUserImageColumn and the clear', () => {
  // Keys in the form the clear matches another own upload by: a bare upload uuid, or a CDN url around one.
  const A = 'a0000000-0000-4000-8000-0000000000a1';
  const B = 'b0000000-0000-4000-8000-0000000000b2';
  const C = 'c0000000-0000-4000-8000-0000000000c3';
  const D = 'd0000000-0000-4000-8000-0000000000d4';

  beforeAll(async () => {
    await pg.exec(`
      INSERT INTO "Image" (id, "userId", url, "needsReview", ingestion, "nsfwLevel", "blockedFor") VALUES
        (40, 40, '${A}', 'minor', 'Scanned', 1, NULL),
        (41, 40, '${B}', NULL, 'Scanned', 1, NULL),
        (42, 41, '${C}', NULL, 'Scanned', 1, NULL),
        (43, 41, '${B.replace('b2', 'b9')}', NULL, 'Scanned', 1, NULL),
        (44, 42, '${D}', NULL, 'Scanned', 1, 'moderated'),
        (45, 99, '${C.replace('c3', 'c8')}', 'csam', 'Scanned', 1, NULL);
      INSERT INTO "User" (id, "profilePictureId", image, meta) VALUES
        (40, 41, 'https://cdn.example/xG1/${A}/width=96', '{}'),
        (41, 43, '${C}', '{}'),
        (42, NULL, '${D}', '{}'),
        (43, NULL, '${C.replace('c3', 'c8')}', '{}');
    `);
  });

  it('leaves out an older own upload that is held or blocked, and keeps a clean one and another user’s key', async () => {
    const { rows } = await pg.query<{ id: number; image: string | null }>(
      `SELECT u.id, ${fallbackUserImageColumn} AS image FROM "User" u WHERE u.id BETWEEN 40 AND 43 ORDER BY u.id`
    );
    expect(rows.map((row) => [row.id, row.image])).toEqual([
      // A: an older own upload under a minor hold, while the profile picture B is clean.
      [40, null],
      // C: an older own upload, clean.
      [41, C],
      // D: an own upload with a block reason, and no profile picture.
      [42, null],
      // Another user's held image key: not this user's upload, so not this rule's to hide.
      [43, C.replace('c3', 'c8')],
    ]);
  });

  it('agrees with the clear on the same rows', async () => {
    const { rows } = await pg.query<{ id: number }>(
      `SELECT u.id FROM "User" u WHERE u.id BETWEEN 40 AND 43 AND (${fallbackUserImageColumn}) IS NULL ORDER BY u.id`
    );
    const nulledByFallback = rows.map((row) => row.id);
    const cleared = (await clearHeldUserImages(db, [40, 41, 42, 43])).sort((a, b) => a - b);
    expect(nulledByFallback).toEqual([40, 42]);
    expect(cleared).toEqual(nulledByFallback);
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
      `SELECT ${fallbackUserImageColumn} AS image FROM "User" u WHERE u.id BETWEEN 20 AND 39 ORDER BY u.id`
    );
    expect(rows.map((row) => row.image)).toEqual([null, null, 'another-value', 'key-clean']);
  });
});
