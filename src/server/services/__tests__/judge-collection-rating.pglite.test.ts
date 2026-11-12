import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SearchIndex from '~/server/search-index';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

/**
 * A judge's rating in a collection with `judgesApplyBrowsingLevel`, against real rows: it applies
 * only on top of a finished scan, never lowers the scan's level, never touches the scan state, and
 * it is what lets the item be approved. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  imagesSearchIndex: { queueUpdate: vi.fn() },
}));

const { setCollectionItemNsfwLevel, updateCollectionItemsStatus } = await import(
  '~/server/services/collection.service'
);

const COLLECTION_ID = 10;
const OTHER_COLLECTION_ID = 11;
const ITEM_ID = 20;
const IMAGE_ID = 55;
const POST_ID = 70;
const JUDGE_ID = 900;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Post" (id int PRIMARY KEY, "collectionId" int);
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "postId" int REFERENCES "Post"(id),
      "nsfwLevel" int NOT NULL DEFAULT 0,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
      "blockedFor" text,
      "scannedAt" timestamp(3),
      metadata jsonb,
      "updatedAt" timestamp(3)
    );
    CREATE TABLE "CollectionItem" (
      id int PRIMARY KEY,
      "collectionId" int NOT NULL,
      "imageId" int REFERENCES "Image"(id)
    );
  `);
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});
afterAll(() => db.close());

const SCANNED_AT = '2026-01-01 00:00:00';

async function seed(image: {
  ingestion: string;
  nsfwLevel: number;
  blockedFor?: string | null;
  postCollectionId?: number;
}) {
  await db.query(`INSERT INTO "Post" (id, "collectionId") VALUES ($1, $2)`, [
    POST_ID,
    image.postCollectionId ?? COLLECTION_ID,
  ]);
  await db.query(
    `INSERT INTO "Image" (id, "postId", "nsfwLevel", ingestion, "blockedFor", "scannedAt")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [IMAGE_ID, POST_ID, image.nsfwLevel, image.ingestion, image.blockedFor ?? null, SCANNED_AT]
  );
  await db.query(
    `INSERT INTO "CollectionItem" (id, "collectionId", "imageId") VALUES ($1, $2, $3)`,
    [ITEM_ID, COLLECTION_ID, IMAGE_ID]
  );
}

const imageRow = async () =>
  (
    await db.query<{
      nsfwLevel: number;
      nsfwLevelLocked: boolean;
      ingestion: string;
      blockedFor: string | null;
      scannedAt: Date | null;
      metadata: { judgeRating?: { userId: number; nsfwLevel: number; ratedAt: string } } | null;
    }>(`SELECT * FROM "Image" WHERE id = $1`, [IMAGE_ID])
  ).rows[0];

const rate = (nsfwLevel: NsfwLevel) =>
  setCollectionItemNsfwLevel({ collectionItemId: ITEM_ID, nsfwLevel, userId: JUDGE_ID });

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`DELETE FROM "CollectionItem"; DELETE FROM "Image"; DELETE FROM "Post";`);
  dbMock.dbRead.collectionItem.findUniqueOrThrow.mockResolvedValue({
    id: ITEM_ID,
    imageId: IMAGE_ID,
    collectionId: COLLECTION_ID,
    collection: { type: 'Image', metadata: { judgesApplyBrowsingLevel: true } },
  } as never);
  dbMock.dbWrite.collection.findUnique.mockResolvedValue({
    id: COLLECTION_ID,
    type: 'Image',
    mode: null,
    name: 'c',
    metadata: { judgesApplyBrowsingLevel: true },
  } as never);
});

describe('setCollectionItemNsfwLevel: a judge rating on top of the scan', () => {
  it('refuses an image whose scan has not finished, with a retry message', async () => {
    await seed({ ingestion: 'Pending', nsfwLevel: 0 });

    await expect(rate(NsfwLevel.R)).rejects.toThrow(/still being scanned/i);
    expect((await imageRow()).nsfwLevel).toBe(0);
    expect((await imageRow()).ingestion).toBe('Pending');
  });

  it('refuses a Blocked image and leaves the block in place', async () => {
    await seed({ ingestion: 'Blocked', nsfwLevel: NsfwLevel.Blocked, blockedFor: 'tos' });

    await expect(rate(NsfwLevel.PG)).rejects.toThrow(/blocked/i);
    const row = await imageRow();
    expect(row).toMatchObject({ ingestion: 'Blocked', blockedFor: 'tos', nsfwLevel: 32 });
  });

  it('refuses a Scanned image that still carries a block reason, and keeps it', async () => {
    // A rescan request can move ingestion off Blocked while the reason stays.
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R, blockedFor: 'tos' });

    await expect(rate(NsfwLevel.X)).rejects.toThrow(/blocked/i);
    expect((await imageRow()).blockedFor).toBe('tos');
  });

  it('keeps the scan level when the judge picks a lower one', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.X });

    // The caller is told the saved level, so the judge's control shows it.
    await expect(rate(NsfwLevel.PG)).resolves.toEqual({ nsfwLevel: NsfwLevel.X });

    expect((await imageRow()).nsfwLevel).toBe(NsfwLevel.X);
  });

  it('raises the level when the judge picks a higher one', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG13 });

    await rate(NsfwLevel.R);

    expect((await imageRow()).nsfwLevel).toBe(NsfwLevel.R);
  });

  it('leaves the level unlocked, so a later scan can raise it, and never writes the scan state', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG });

    await rate(NsfwLevel.R);

    const row = await imageRow();
    expect(row.nsfwLevelLocked).toBe(false);
    expect(row.ingestion).toBe('Scanned');
    expect(row.blockedFor).toBeNull();
    expect(row.scannedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('records the judge, the level they picked and when', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.X });

    await rate(NsfwLevel.PG13);

    const { judgeRating } = (await imageRow()).metadata ?? {};
    expect(judgeRating).toMatchObject({ userId: JUDGE_ID, nsfwLevel: NsfwLevel.PG13 });
    expect(Number.isNaN(Date.parse(judgeRating?.ratedAt ?? ''))).toBe(false);
  });

  it('refuses the Blocked level as a judge rating', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG });

    await expect(rate(NsfwLevel.Blocked)).rejects.toThrow();
    expect((await imageRow()).nsfwLevel).toBe(NsfwLevel.PG);
  });

  it('refuses an image posted to another collection', async () => {
    await seed({
      ingestion: 'Scanned',
      nsfwLevel: NsfwLevel.PG,
      postCollectionId: OTHER_COLLECTION_ID,
    });

    await expect(rate(NsfwLevel.R)).rejects.toThrow(/not created for this collection/i);
    expect((await imageRow()).metadata).toBeNull();
  });
});

describe('updateCollectionItemsStatus: approving in a judge-rated collection', () => {
  const approve = () =>
    updateCollectionItemsStatus({
      input: {
        collectionId: COLLECTION_ID,
        collectionItemIds: [ITEM_ID],
        status: CollectionItemStatus.ACCEPTED,
      },
      userId: JUDGE_ID,
      isSystem: true,
    });

  it('refuses an item no judge has rated, even after a scan set its level', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R });

    await expect(approve()).rejects.toThrow(/NSFW rating/);
  });

  it('lets a judge-rated item past the rating check', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R });
    await rate(NsfwLevel.R);
    // The first read after the rating check: reaching it means the check passed.
    dbMock.dbWrite.collectionItem.findMany.mockRejectedValue(new Error('past the rating check'));

    await expect(approve()).rejects.toThrow('past the rating check');
  });
});
