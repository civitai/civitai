import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';

/**
 * The folder reads against real tables: per-type counts, which items a folder card shows, and who
 * may open a folder. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let pg: PGlite;
vi.mock('~/server/db/kyselyDb', () => ({
  kyselyRead: pgliteKysely(() => pg),
  kyselyWrite: pgliteKysely(() => pg),
}));

const { getFolderSummaries, getProfileFolder, getFolderItems } = await import(
  '~/server/services/profile-folder-reads.service'
);

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
const PRIVATE_FOLDER = 11;
const COLLECTION = 12;
const UNLISTED_FOLDER = 13;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "CollectionMode" AS ENUM ('Contest', 'Bookmark');
    CREATE TABLE "Collection" (
      id int PRIMARY KEY, "userId" int NOT NULL, mode "CollectionMode",
      name text NOT NULL DEFAULT 'f', description text, read text NOT NULL DEFAULT 'Public'
    );
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
  const [part1, part2] = MIGRATION.split(/^-- Part 2.*$/m);
  await pg.exec(part1);
  await pg.exec(part2);
});

afterAll(async () => {
  await pg?.close();
});

const item = (id: number, column: 'modelId' | 'imageId' | 'articleId', extra = '') =>
  pg.query(
    `INSERT INTO "CollectionItem" (id, "collectionId", "${column}"${extra ? ', status' : ''})
     VALUES ($1, $2, $1${extra ? ', $3' : ''})`,
    extra ? [id, FOLDER, extra] : [id, FOLDER]
  );

beforeEach(async () => {
  await pg.exec(`DELETE FROM "CollectionItem"; DELETE FROM "Collection";`);
  await pg.query(
    `INSERT INTO "Collection" (id, "userId", mode, read) VALUES
       ($1, $4, 'Folder', 'Public'), ($2, $4, 'Folder', 'Private'), ($3, $4, NULL, 'Public'),
       ($5, $4, 'Folder', 'Unlisted')`,
    [FOLDER, PRIVATE_FOLDER, COLLECTION, OWNER, UNLISTED_FOLDER]
  );
});

describe('getFolderSummaries', () => {
  it('counts accepted items by type', async () => {
    await item(1, 'modelId');
    await item(2, 'imageId');
    await item(3, 'imageId');
    await item(4, 'articleId');
    await item(5, 'imageId', 'REJECTED');
    const summary = (await getFolderSummaries([FOLDER, PRIVATE_FOLDER])).get(FOLDER);
    expect(summary?.counts).toEqual({ Model: 1, Image: 2, Article: 1, total: 4 });
    expect((await getFolderSummaries([PRIVATE_FOLDER])).get(PRIVATE_FOLDER)?.counts.total).toBe(0);
  });

  it('shows the newest items on the card until something is showcased, then only those', async () => {
    for (let id = 1; id <= 10; id++) await item(id, 'imageId');
    const newest = (await getFolderSummaries([FOLDER])).get(FOLDER)?.preview.map((ref) => ref.id);
    expect(newest).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);

    await pg.exec(`
      UPDATE "CollectionItem" SET "showcasedAt" = now() - interval '1 hour' WHERE id = 2;
      UPDATE "CollectionItem" SET "showcasedAt" = now() WHERE id = 7;
    `);
    const showcased = (await getFolderSummaries([FOLDER])).get(FOLDER)?.preview;
    expect(showcased).toEqual([
      { type: 'Image', id: 2 },
      { type: 'Image', id: 7 },
    ]);
  });
});

describe('getProfileFolder', () => {
  it('opens a public folder for a visitor, with its counts', async () => {
    await item(1, 'modelId');
    const folder = await getProfileFolder({ folderId: FOLDER, userId: OWNER, viewerId: STRANGER });
    expect(folder).toMatchObject({ id: FOLDER, isOwner: false, counts: { Model: 1, total: 1 } });
  });

  it('opens an unlisted folder for a visitor who has its link', async () => {
    await expect(
      getProfileFolder({ folderId: UNLISTED_FOLDER, userId: OWNER, viewerId: STRANGER })
    ).resolves.toMatchObject({ id: UNLISTED_FOLDER, isOwner: false });
  });

  it('hides a private folder from a visitor but not from its owner or a moderator', async () => {
    const open = (viewerId?: number, isModerator?: boolean) =>
      getProfileFolder({ folderId: PRIVATE_FOLDER, userId: OWNER, viewerId, isModerator });
    await expect(open(STRANGER)).rejects.toThrow(/not found/i);
    await expect(open(undefined)).rejects.toThrow(/not found/i);
    await expect(open(OWNER)).resolves.toMatchObject({ id: PRIVATE_FOLDER, isOwner: true });
    await expect(open(STRANGER, true)).resolves.toMatchObject({ id: PRIVATE_FOLDER });
  });

  it("does not open a regular collection, or a folder under another user's profile", async () => {
    await expect(
      getProfileFolder({ folderId: COLLECTION, userId: OWNER, viewerId: OWNER })
    ).rejects.toThrow(/not found/i);
    await expect(
      getProfileFolder({ folderId: FOLDER, userId: STRANGER, viewerId: STRANGER })
    ).rejects.toThrow(/not found/i);
  });
});

describe('getFolderItems', () => {
  it("lists the owner's folder items with their ids and showcase state, and nothing for others", async () => {
    await item(1, 'modelId');
    await item(2, 'articleId');
    await pg.exec(`UPDATE "CollectionItem" SET "showcasedAt" = now() WHERE id = 2`);
    expect(await getFolderItems({ folderId: FOLDER, userId: OWNER })).toEqual([
      { type: 'Article', id: 2, collectionItemId: 2, showcased: true },
      { type: 'Model', id: 1, collectionItemId: 1, showcased: false },
    ]);
    expect(await getFolderItems({ folderId: FOLDER, userId: STRANGER })).toEqual([]);
  });
});
