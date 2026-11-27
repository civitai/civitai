import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';

/**
 * Profile folders against real tables: the migration as written, the showcase cap, and the
 * collected count's folder exclusion. Ids are invented. The cap's row lock is not exercised: this
 * harness runs each statement on its own, so two writes cannot contend for it here.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let pg: PGlite;
vi.mock('~/server/db/kyselyDb', () => ({ kyselyWrite: pgliteKysely(() => pg) }));

const { setItemShowcase } = await import('~/server/services/profile-folder-showcase.service');
const { collectionItemCountSql } = await import('~/server/metrics/collection-item-counts');

const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations/20271124120000_profile_folders/migration.sql'
  ),
  'utf8'
);

const OWNER = 5;
const STRANGER = 6;
const FOLDER = 10;
const COLLECTION = 11;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "CollectionMode" AS ENUM ('Contest', 'Bookmark');
    CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int NOT NULL, mode "CollectionMode");
    CREATE TABLE "CollectionItem" (
      id int PRIMARY KEY,
      "collectionId" int NOT NULL,
      "addedById" int,
      "modelId" int,
      "imageId" int,
      "articleId" int,
      "postId" int,
      status text NOT NULL DEFAULT 'ACCEPTED'
    );
    CREATE TABLE "UserProfile" ("userId" int PRIMARY KEY);
  `);
  // The file's two parts as the applier runs them: part 1, then the CONCURRENTLY index on its own.
  const [part1, part2] = MIGRATION.split(/^-- Part 2.*$/m);
  await pg.exec(part1);
  await pg.exec(part2);
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM "CollectionItem"; DELETE FROM "Collection";`);
  await pg.query(`INSERT INTO "Collection" VALUES ($1, $2, 'Folder'), ($3, $2, NULL)`, [
    FOLDER,
    OWNER,
    COLLECTION,
  ]);
  for (let id = 1; id <= 10; id++)
    await pg.query(
      `INSERT INTO "CollectionItem" (id, "collectionId", "addedById", "modelId") VALUES ($1, $2, $3, $1)`,
      [id, FOLDER, OWNER]
    );
});

const showcasedCount = async () =>
  Number(
    (
      await pg.query<{ n: number }>(
        `SELECT count(*) AS n FROM "CollectionItem" WHERE "collectionId" = $1 AND "showcasedAt" IS NOT NULL`,
        [FOLDER]
      )
    ).rows[0].n
  );

describe('the migration', () => {
  it('adds the columns, the enum value and a valid partial index', async () => {
    const index = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'CollectionItem_showcase_idx'`
    );
    expect(index.rows[0]?.indexdef).toContain('WHERE ("showcasedAt" IS NOT NULL)');
    const folders = await pg.query(`SELECT 1 FROM "Collection" WHERE mode = 'Folder'`);
    expect(folders.rows).toHaveLength(1);
  });
});

describe('setItemShowcase', () => {
  it('showcases up to 8 items and refuses the 9th', async () => {
    for (let id = 1; id <= 8; id++)
      await setItemShowcase({ userId: OWNER, collectionItemId: id, showcased: true });
    await expect(
      setItemShowcase({ userId: OWNER, collectionItemId: 9, showcased: true })
    ).rejects.toThrow(/up to 8/);
    expect(await showcasedCount()).toBe(8);
  });

  it('frees a slot when an item is un-showcased', async () => {
    for (let id = 1; id <= 8; id++)
      await setItemShowcase({ userId: OWNER, collectionItemId: id, showcased: true });
    await setItemShowcase({ userId: OWNER, collectionItemId: 3, showcased: false });
    await setItemShowcase({ userId: OWNER, collectionItemId: 9, showcased: true });
    expect(await showcasedCount()).toBe(8);
  });

  it("refuses an item in someone else's folder, or in a collection that is not a folder", async () => {
    await expect(
      setItemShowcase({ userId: STRANGER, collectionItemId: 1, showcased: true })
    ).rejects.toThrow(/not found/i);
    await pg.query(
      `INSERT INTO "CollectionItem" (id, "collectionId", "addedById", "modelId") VALUES (99, $1, $2, 99)`,
      [COLLECTION, OWNER]
    );
    await expect(
      setItemShowcase({ userId: OWNER, collectionItemId: 99, showcased: true })
    ).rejects.toThrow(/not found/i);
    expect(await showcasedCount()).toBe(0);
  });
});

describe('collected count', () => {
  it('does not count an owner filing their own model in a folder', async () => {
    // Model 1 sits in the owner's folder (from beforeEach) and in a stranger's normal collection.
    await pg.query(`INSERT INTO "Collection" VALUES (12, $1, NULL)`, [STRANGER]);
    await pg.query(
      `INSERT INTO "CollectionItem" (id, "collectionId", "addedById", "modelId") VALUES (50, 12, $1, 1)`,
      [STRANGER]
    );
    const rows = (
      await pg.query<{ id: number; n: number }>(collectionItemCountSql('Model'), [[1], []])
    ).rows;
    expect(rows).toEqual([{ id: 1, n: 1 }]);
  });
});
