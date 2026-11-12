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
let raw: ReturnType<typeof pgliteRaw>;

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
      "scanJobs" jsonb,
      metadata jsonb,
      "updatedAt" timestamp(3)
    );
    CREATE TABLE "CollectionItem" (
      id int PRIMARY KEY,
      "collectionId" int NOT NULL,
      "imageId" int REFERENCES "Image"(id)
    );
  `);
  raw = pgliteRaw(db);
});
afterAll(() => db.close());

const SCANNED_AT = '2026-01-01 00:00:00';
const SCANNED = '{"workflowId": "wf-1"}';

async function seed(image: {
  ingestion: string;
  nsfwLevel: number;
  blockedFor?: string | null;
  postCollectionId?: number;
  scanJobs?: string | null;
}) {
  await db.query(`INSERT INTO "Post" (id, "collectionId") VALUES ($1, $2)`, [
    POST_ID,
    image.postCollectionId ?? COLLECTION_ID,
  ]);
  await db.query(
    `INSERT INTO "Image" (id, "postId", "nsfwLevel", ingestion, "blockedFor", "scannedAt", "scanJobs")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      IMAGE_ID,
      POST_ID,
      image.nsfwLevel,
      image.ingestion,
      image.blockedFor ?? null,
      SCANNED_AT,
      image.scanJobs === undefined ? SCANNED : image.scanJobs,
    ]
  );
  await db.query(
    `INSERT INTO "CollectionItem" (id, "collectionId", "imageId") VALUES ($1, $2, $3)`,
    [ITEM_ID, COLLECTION_ID, IMAGE_ID]
  );
}

type JudgeRating = { userId: number; nsfwLevel: number; ratedAt: string; collectionId: number };

const imageRow = async () =>
  (
    await db.query<{
      nsfwLevel: number;
      nsfwLevelLocked: boolean;
      ingestion: string;
      blockedFor: string | null;
      scannedAt: Date | null;
      metadata: { judgeRating?: JudgeRating } | null;
    }>(`SELECT * FROM "Image" WHERE id = $1`, [IMAGE_ID])
  ).rows[0];

const rate = (nsfwLevel: NsfwLevel) =>
  setCollectionItemNsfwLevel({ collectionItemId: ITEM_ID, nsfwLevel, userId: JUDGE_ID });

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

/** The first read after the rating check: reaching it means the check passed. */
const PAST_GATE = 'past the rating check';

beforeEach(async () => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  dbMock.dbWrite.collectionItem.findMany.mockRejectedValue(new Error(PAST_GATE));
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
    await seed({ ingestion: 'Pending', nsfwLevel: 0, scanJobs: null });

    await expect(rate(NsfwLevel.R)).rejects.toThrow(/still being scanned/i);
    expect(await imageRow()).toMatchObject({ nsfwLevel: 0, ingestion: 'Pending', metadata: null });
  });

  it('refuses a Scanned image that carries no scan workflow', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG, scanJobs: null });

    await expect(rate(NsfwLevel.R)).rejects.toThrow(/still being scanned/i);
    expect(await imageRow()).toMatchObject({ nsfwLevel: NsfwLevel.PG, metadata: null });
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

  it.each([
    ['moved to Rescan', `UPDATE "Image" SET ingestion = 'Rescan'`],
    ['was blocked', `UPDATE "Image" SET "blockedFor" = 'tos'`],
    ['lost its scan workflow', `UPDATE "Image" SET "scanJobs" = NULL`],
  ])('refuses, writing nothing, when the image %s after the check read it', async (_, change) => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG });
    // The check reads the row as it was; the row changes before the write.
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      ...args: Parameters<typeof raw.queryRaw>
    ) => {
      const rows = await raw.queryRaw(...args);
      const text = Array.isArray(args[0]) ? (args[0] as string[]).join('') : '';
      if (text.includes('AS "postCollectionId"')) await db.exec(change);
      return rows;
    }) as never);

    await expect(rate(NsfwLevel.R)).rejects.toThrow(/changed while it was being rated/i);
    expect(await imageRow()).toMatchObject({ nsfwLevel: NsfwLevel.PG, metadata: null });
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

  it('leaves the level unlocked and never writes the scan state', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG });

    await rate(NsfwLevel.R);

    const row = await imageRow();
    expect(row.nsfwLevelLocked).toBe(false);
    expect(row.ingestion).toBe('Scanned');
    expect(row.blockedFor).toBeNull();
    expect(row.scannedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('records the judge, the collection, the level they picked and when', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.X });

    await rate(NsfwLevel.PG13);

    const { judgeRating } = (await imageRow()).metadata ?? {};
    expect(judgeRating).toMatchObject({
      userId: JUDGE_ID,
      nsfwLevel: NsfwLevel.PG13,
      collectionId: COLLECTION_ID,
    });
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
  it('refuses an item no judge has rated, even after a scan set its level', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R });

    await expect(approve()).rejects.toThrow(/NSFW rating/);
  });

  it('lets a judge-rated item past the rating check', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R });
    await rate(NsfwLevel.R);

    await expect(approve()).rejects.toThrow(PAST_GATE);
  });

  it.each([
    [
      "carries another collection's rating",
      `UPDATE "Image" SET metadata = jsonb_set(metadata, '{judgeRating,collectionId}', '${OTHER_COLLECTION_ID}')`,
    ],
    [
      'was blocked after the rating',
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'tos', "nsfwLevel" = 32`,
    ],
    ['has a block reason', `UPDATE "Image" SET "blockedFor" = 'tos'`],
    ['carries no scan workflow', `UPDATE "Image" SET "scanJobs" = NULL`],
  ])('refuses a rated item that %s', async (_, change) => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R });
    await rate(NsfwLevel.R);
    await db.exec(change);

    await expect(approve()).rejects.toThrow(/NSFW rating/);
  });
});
