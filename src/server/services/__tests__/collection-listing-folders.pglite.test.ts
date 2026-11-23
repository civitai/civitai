import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Profile folders stay out of a user's collection lists (My Collections, the save picker): the
 * union query of getUserCollectionsWithPermissions runs against PGlite. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { getUserCollectionsWithPermissions } = await import('~/server/services/collection.service');

const USER = 5;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "CollectionMode" AS ENUM ('Contest', 'Bookmark', 'Folder');
    CREATE TYPE "CollectionType" AS ENUM ('Model', 'Image', 'Article', 'Post', 'Model3D');
    CREATE TYPE "CollectionReadConfiguration" AS ENUM ('Private', 'Public', 'Unlisted');
    CREATE TYPE "CollectionWriteConfiguration" AS ENUM ('Private', 'Public', 'Review');
    CREATE TABLE "Collection" (
      id int PRIMARY KEY, name text, description text, read "CollectionReadConfiguration",
      "userId" int, write "CollectionWriteConfiguration", "imageId" int, type "CollectionType",
      mode "CollectionMode", "archivedAt" timestamp, "createdAt" timestamp, "updatedAt" timestamp,
      metadata jsonb
    );
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "CollectionContributor" (
      "userId" int, "collectionId" int, permissions "CollectionContributorPermission"[]
    );
    INSERT INTO "Collection" (id, name, read, "userId", write, type, mode) VALUES
      (1, 'plain', 'Public', 5, 'Private', NULL, NULL),
      (2, 'bookmarks', 'Private', 5, 'Private', 'Model', 'Bookmark'),
      (3, 'my folder', 'Public', 5, 'Private', NULL, 'Folder'),
      (4, 'someone''s folder', 'Public', 6, 'Private', NULL, 'Folder'),
      (5, 'someone''s public', 'Public', 6, 'Public', NULL, NULL);
  `);
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(() => {
  const route = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    if (sql.text.includes('FROM "Collection"'))
      return (await pg.query(sql.text, sql.values as unknown[])).rows;
    return [];
  }) as never;
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(route);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(route);
});

const listedIds = async (input: object) =>
  (await getUserCollectionsWithPermissions({ input: { userId: USER, ...input } as never }))
    .map((c) => c.id)
    .sort();

describe('getUserCollectionsWithPermissions', () => {
  it("lists the user's own collections but not their folders", async () => {
    expect(await listedIds({})).toEqual([1, 2]);
  });

  it('keeps folders out of the public-read branch as well', async () => {
    expect(await listedIds({ permissions: ['VIEW', 'ADD'], contributingOnly: false })).toEqual([
      1, 2, 5,
    ]);
  });
});
