import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { restoreClearedUserImages } from '@civitai/db-queries/held-user-image';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle, del } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  del: vi.fn(async (_keys: string[]) => 0),
}));
vi.mock('../db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('../redis', () => ({
  getRedis: () => ({ del, hSet: async () => 1, expire: async () => true }),
}));
vi.mock('../axiom', () => ({ logAxiomError: vi.fn(async () => undefined) }));

import { bustProfilePictures } from '../profile-picture-cache';

let pg: PGlite;
let db: Kysely<DB>;

const marker = (pictureId: unknown) => JSON.stringify({ heldImageCleared: { pictureId } });

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, url text, "needsReview" text);
    CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int, image text, meta jsonb);
    INSERT INTO "Image" VALUES (1, 'key-lifted', NULL), (2, 'key-held', 'minor'), (3, 'key-other', NULL);
  `);
  db = new Kysely<DB>({ dialect: pgliteDialect(pg) });
  dbHandle.current = db;
  del.mockClear();
});
afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

const users = async () =>
  (
    await pg.query<{ id: number; image: string | null; meta: Record<string, unknown> | null }>(
      'SELECT id, image, meta FROM "User" ORDER BY id'
    )
  ).rows;

describe('restoreClearedUserImages', () => {
  it("puts back a cleared User.image from the picture's own url once its hold lifts, and only then", async () => {
    await pg.exec(`
      INSERT INTO "User" VALUES
        (1, 1, NULL, '${marker(1)}'::jsonb || '{"keep": true}'::jsonb),
        (2, 2, NULL, '${marker(2)}'),
        (3, 3, NULL, '${marker(1)}'),
        (4, 1, 'set-since', '${marker(1)}'),
        (5, 1, NULL, '{"x": 1}'),
        (6, 1, NULL, '${marker('not-a-number')}'),
        (7, 1, NULL, '"a string meta"');
    `);

    const query = async (text: string, values: unknown[]) => (await pg.query(text, values)).rows;
    expect((await restoreClearedUserImages(query, [1, 2, 3, 4, 5, 6, 7])).sort()).toEqual([1]);

    expect(await users()).toEqual([
      // Restored, its other meta kept.
      { id: 1, image: 'key-lifted', meta: { keep: true } },
      // Still held: marker kept for later.
      { id: 2, image: null, meta: { heldImageCleared: { pictureId: 2 } } },
      // Picture changed since: nothing restored, marker dropped.
      { id: 3, image: null, meta: {} },
      // User.image set since: nothing restored, marker dropped.
      { id: 4, image: 'set-since', meta: {} },
      // No marker: untouched.
      { id: 5, image: null, meta: { x: 1 } },
      // A forged marker naming no picture restores nothing and does not fail the statement.
      { id: 6, image: null, meta: {} },
      { id: 7, image: null, meta: 'a string meta' },
    ]);
  });
});

describe("a moderator's lift of a hold", () => {
  it("restores the owner's User.image and evicts their basic-user cache entry", async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 1, NULL, '${marker(1)}'), (2, 3, NULL, NULL);`);

    await bustProfilePictures({ userIds: [1, 2] });

    expect((await users())[0].image).toBe('key-lifted');
    const busted = del.mock.calls.flatMap(([keys]) => keys);
    expect(busted).toContain('packed:caches:basic-users:1');
    expect(busted).not.toContain('packed:caches:basic-users:2');
  });
});
