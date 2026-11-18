import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

/**
 * The page cursor of `collection.getAllCollectionItems` names an item; the page continues after
 * that item's position. The item query runs against PGlite; the collection's permission row and
 * the image hydration are stubbed. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockGetAllImages } = vi.hoisted(() => ({ mockGetAllImages: vi.fn() }));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: mockGetAllImages,
}));

const { dbMock } = await import('~/__tests__/mocks/db.mock');
const { getCollectionItemsByCollectionId } = await import('~/server/services/collection.service');

const COLLECTION_ID = 7;
const OTHER_COLLECTION_ID = 8;
const OWNER = 9;
const SUBMITTER = { id: 77, isModerator: false };
const OTHER_SUBMITTER = 500;

// Items are listed newest first. Image id = item id + 100.
// 1 (oldest) and 3 are the submitter's; 2, between them, is someone else's; 4 is in another
// collection, also between them.
const ITEMS = [
  { id: 1, collectionId: COLLECTION_ID, addedById: SUBMITTER.id, at: '2026-01-01' },
  { id: 2, collectionId: COLLECTION_ID, addedById: OTHER_SUBMITTER, at: '2026-01-02' },
  { id: 4, collectionId: OTHER_COLLECTION_ID, addedById: OTHER_SUBMITTER, at: '2026-01-02' },
  { id: 3, collectionId: COLLECTION_ID, addedById: SUBMITTER.id, at: '2026-01-03' },
];

let pg: PGlite;
let collectionRead = 'Private';

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, ingestion text NOT NULL);
    CREATE TABLE "CollectionItem" (
      id int PRIMARY KEY,
      "collectionId" int NOT NULL,
      "addedById" int,
      "imageId" int,
      "modelId" int,
      "postId" int,
      "articleId" int,
      "tagId" int,
      "reviewedById" int,
      status text NOT NULL,
      "createdAt" timestamp
    );
  `);
  for (const item of ITEMS) {
    await pg.query(`INSERT INTO "Image" VALUES ($1, 'Scanned')`, [item.id + 100]);
    await pg.query(
      `INSERT INTO "CollectionItem" (id, "collectionId", "addedById", "imageId", status, "createdAt")
       VALUES ($1, $2, $3, $4, 'ACCEPTED', $5)`,
      [item.id, item.collectionId, item.addedById, item.id + 100, item.at]
    );
  }
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  collectionRead = 'Private';
  const route = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    if (sql.text.includes('FROM "CollectionItem" ci'))
      return (await pg.query(sql.text, sql.values as unknown[])).rows;
    if (sql.text.includes('FROM "Collection" c'))
      return [
        {
          id: COLLECTION_ID,
          read: collectionRead,
          write: 'Public',
          userId: OWNER,
          type: 'Image',
          mode: null,
          collaborationDisabledAt: null,
          contributorPermissions: null,
          hasAcceptedSeat: false,
        },
      ];
    return [];
  }) as never;
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(route);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(route);
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    vi.mocked(db.collection.findUniqueOrThrow).mockResolvedValue({
      id: COLLECTION_ID,
      type: 'Image',
      mode: null,
      userId: OWNER,
    } as never);
  mockGetAllImages.mockImplementation(async ({ ids }: { ids: number[] }) => ({
    items: ids.map((id) => ({ id })),
  }));
});

const itemIdsAfter = async (cursor: number, user: object = SUBMITTER) =>
  (
    await getCollectionItemsByCollectionId({
      input: { collectionId: COLLECTION_ID, limit: 10, browsingLevel: 3, cursor: String(cursor) },
      user: user as never,
      requireRead: true,
    } as never)
  ).items.map((item) => (item as unknown as { data: { id: number } }).data.id - 100);

describe('the page cursor', () => {
  it("continues after one of the viewer's own items (control)", async () => {
    expect(await itemIdsAfter(3)).toEqual([1]);
  });

  it("answers a submitter's cursor naming someone else's item as one naming no item", async () => {
    // A Private collection the viewer may only submit to: they list their own items.
    expect(await itemIdsAfter(2)).toEqual(await itemIdsAfter(999));
  });

  it("answers a cursor naming another collection's item as one naming no item", async () => {
    collectionRead = 'Public';
    expect(await itemIdsAfter(4)).toEqual(await itemIdsAfter(999));
  });

  it("continues after someone else's item for a viewer who may read the collection (control)", async () => {
    collectionRead = 'Public';
    expect(await itemIdsAfter(2)).toEqual([1]);
  });
});
