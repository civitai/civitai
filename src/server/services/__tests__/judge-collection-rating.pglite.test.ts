import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SearchIndex from '~/server/search-index';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import { judgeRatingFloorSql } from '~/server/common/judge-rating';
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
      "needsReview" text,
      metadata jsonb,
      "updatedAt" timestamp(3)
    );
    CREATE TYPE "JobQueueType" AS ENUM ('ImageScan');
    CREATE TYPE "EntityType" AS ENUM ('Image');
    CREATE TABLE "JobQueue" (
      type "JobQueueType" NOT NULL,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      PRIMARY KEY (type, "entityType", "entityId")
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
  needsReview?: string | null;
}) {
  await db.query(`INSERT INTO "Post" (id, "collectionId") VALUES ($1, $2)`, [
    POST_ID,
    image.postCollectionId ?? COLLECTION_ID,
  ]);
  await db.query(
    `INSERT INTO "Image" (id, "postId", "nsfwLevel", ingestion, "blockedFor", "scannedAt", "scanJobs", "needsReview")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      IMAGE_ID,
      POST_ID,
      image.nsfwLevel,
      image.ingestion,
      image.blockedFor ?? null,
      SCANNED_AT,
      image.scanJobs === undefined ? SCANNED : image.scanJobs,
      image.needsReview ?? null,
    ]
  );
  await db.query(
    `INSERT INTO "CollectionItem" (id, "collectionId", "imageId") VALUES ($1, $2, $3)`,
    [ITEM_ID, COLLECTION_ID, IMAGE_ID]
  );
}

type JudgeRating = {
  userId: number | null;
  nsfwLevel: number;
  ratedAt: string | null;
  collectionId: number;
  legacy?: boolean;
};

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

const queuedScans = async () =>
  (
    await db.query<{ entityId: number }>(
      `SELECT "entityId" FROM "JobQueue" WHERE type = 'ImageScan'`
    )
  ).rows;

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
  await db.exec(
    `DELETE FROM "CollectionItem"; DELETE FROM "Image"; DELETE FROM "Post"; DELETE FROM "JobQueue";`
  );
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
    const row = await imageRow();
    // Only the legacy floor of the level it had, never the judge's pick.
    expect(row.nsfwLevel).toBe(NsfwLevel.PG);
    expect(row.metadata?.judgeRating).toMatchObject({ nsfwLevel: NsfwLevel.PG, legacy: true });
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

  it.each(['minor', 'poi', 'modRule'])(
    'refuses an image held for moderator review (%s), and leaves it unchanged',
    async (needsReview) => {
      await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG13 });
      await db.query(`UPDATE "Image" SET "needsReview" = $1`, [needsReview]);

      await expect(rate(NsfwLevel.X)).rejects.toThrow(/waiting for moderator review/i);
      expect(await imageRow()).toMatchObject({
        nsfwLevel: NsfwLevel.PG13,
        ingestion: 'Scanned',
        metadata: null,
      });
    }
  );

  it.each([
    ['moved to Rescan', `UPDATE "Image" SET ingestion = 'Rescan'`],
    ['was held for review', `UPDATE "Image" SET "needsReview" = 'minor'`],
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
    await expect(rate(NsfwLevel.PG)).resolves.toEqual({
      nsfwLevel: NsfwLevel.X,
      rescanning: false,
    });

    expect((await imageRow()).nsfwLevel).toBe(NsfwLevel.X);
  });

  it('raises the level when the judge picks a higher SFW one', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG });

    await expect(rate(NsfwLevel.PG13)).resolves.toEqual({
      nsfwLevel: NsfwLevel.PG13,
      rescanning: false,
    });

    expect((await imageRow()).nsfwLevel).toBe(NsfwLevel.PG13);
  });

  it('leaves the level unlocked and the scan state alone for a raise within SFW', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG });

    await rate(NsfwLevel.PG13);

    const row = await imageRow();
    expect(row).toMatchObject({
      nsfwLevel: NsfwLevel.PG13,
      nsfwLevelLocked: false,
      ingestion: 'Scanned',
      blockedFor: null,
    });
    expect(row.scannedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('sends a raise into an NSFW level back through the scan, which holds approval', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG13 });

    expect(await rate(NsfwLevel.X)).toEqual({ nsfwLevel: NsfwLevel.PG13, rescanning: true });

    const row = await imageRow();
    expect(row).toMatchObject({ ingestion: 'Rescan', blockedFor: null });
    expect(row.metadata?.judgeRating).toMatchObject({ nsfwLevel: NsfwLevel.X });
    expect(row.scannedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    await expect(approve()).rejects.toThrow(/still being scanned/i);
  });

  it('keeps the old level while the rescan runs, so the image never shows a level unchecked', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG13 });

    await expect(rate(NsfwLevel.X)).resolves.toEqual({
      nsfwLevel: NsfwLevel.PG13,
      rescanning: true,
    });

    expect(await imageRow()).toMatchObject({ nsfwLevel: NsfwLevel.PG13, ingestion: 'Rescan' });
  });

  it('does not rescan when the judge picks no higher than the scan', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.X });

    await rate(NsfwLevel.R);

    expect(await imageRow()).toMatchObject({ nsfwLevel: NsfwLevel.X, ingestion: 'Scanned' });
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
    [
      'carries only a legacy rating',
      `UPDATE "Image" SET metadata = jsonb_set(metadata, '{judgeRating}', (metadata->'judgeRating') || '{"legacy": true, "userId": null}')`,
    ],
  ])('refuses a rated item that %s', async (_, change) => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R });
    await rate(NsfwLevel.R);
    await db.exec(change);

    await expect(approve()).rejects.toThrow(/NSFW rating/);
  });
});

describe('an image that was never scanned', () => {
  // Uploads from before collection images were scanned: Scanned with no scan record, or waiting for
  // a manual level. A rating or an approval sends it to the scan once, and waits for the verdict.
  it.each([
    [
      'Scanned with no scan record',
      { ingestion: 'Scanned', nsfwLevel: NsfwLevel.R, scanJobs: null },
    ],
    [
      'waiting for a manual level',
      { ingestion: 'PendingManualAssignment', nsfwLevel: 0, scanJobs: null },
    ],
  ])('%s: a rating queues one scan and is refused until it lands', async (_, image) => {
    await seed(image);

    await expect(rate(NsfwLevel.R)).rejects.toThrow(/still being scanned/i);

    expect((await imageRow()).ingestion).toBe('Rescan');
    expect(await queuedScans()).toEqual([{ entityId: IMAGE_ID }]);
  });

  it('keeps the level the judges applied as a legacy floor under the rescan', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.X, scanJobs: null });

    await expect(rate(NsfwLevel.X)).rejects.toThrow(/still being scanned/i);

    const row = await imageRow();
    expect(row).toMatchObject({ ingestion: 'Rescan', nsfwLevel: NsfwLevel.X });
    expect(row.metadata?.judgeRating).toEqual({
      userId: null,
      nsfwLevel: NsfwLevel.X,
      ratedAt: null,
      legacy: true,
      collectionId: COLLECTION_ID,
    });
    // A legacy floor never approves.
    await db.exec(
      `UPDATE "Image" SET ingestion = 'Scanned', "scanJobs" = '{"workflowId": "wf-2"}'`
    );
    await expect(approve()).rejects.toThrow(/NSFW rating/);
  });

  it('seeds no floor for an image with no single level, and keeps an existing rating', async () => {
    await seed({ ingestion: 'PendingManualAssignment', nsfwLevel: 0, scanJobs: null });
    await expect(approve()).rejects.toThrow(/still being scanned/i);
    expect((await imageRow()).metadata).toBeNull();

    await db.exec(`DELETE FROM "CollectionItem"; DELETE FROM "Image"; DELETE FROM "Post";`);
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R, scanJobs: null });
    const existing = { userId: 5, nsfwLevel: NsfwLevel.X, collectionId: COLLECTION_ID };
    await db.query(`UPDATE "Image" SET metadata = $1`, [{ judgeRating: existing }]);
    await expect(rate(NsfwLevel.R)).rejects.toThrow(/still being scanned/i);
    expect((await imageRow()).metadata?.judgeRating).toEqual(existing);
  });

  it('queues an image waiting for a manual level even if it carries a scan workflow', async () => {
    await seed({ ingestion: 'PendingManualAssignment', nsfwLevel: 0 });

    await expect(rate(NsfwLevel.R)).rejects.toThrow(/still being scanned/i);

    expect((await imageRow()).ingestion).toBe('Rescan');
    expect(await queuedScans()).toEqual([{ entityId: IMAGE_ID }]);
  });

  it('a second attempt does not queue it again', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R, scanJobs: null });
    await expect(rate(NsfwLevel.R)).rejects.toThrow(/still being scanned/i);
    await db.exec(`DELETE FROM "JobQueue"`);

    await expect(rate(NsfwLevel.R)).rejects.toThrow(/still being scanned/i);
    await expect(approve()).rejects.toThrow(/still being scanned/i);

    expect(await queuedScans()).toEqual([]);
  });

  it('an approval queues the scan and is refused', async () => {
    await seed({ ingestion: 'PendingManualAssignment', nsfwLevel: 0, scanJobs: null });

    await expect(approve()).rejects.toThrow(/still being scanned/i);

    expect((await imageRow()).ingestion).toBe('Rescan');
    expect(await queuedScans()).toEqual([{ entityId: IMAGE_ID }]);
  });

  it('can be rated and approved once the scan verdict lands', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG13, scanJobs: null });
    await expect(rate(NsfwLevel.PG13)).rejects.toThrow(/still being scanned/i);
    await db.exec(
      `UPDATE "Image" SET ingestion = 'Scanned', "scanJobs" = '{"workflowId": "wf-2"}'`
    );

    await rate(NsfwLevel.PG13);

    await expect(approve()).rejects.toThrow(PAST_GATE);
  });

  it.each([
    [
      'held for moderator review',
      { needsReview: 'minor' },
      'This image is waiting for moderator review.',
      'Some of the items selected are waiting for moderator review.',
    ],
    [
      'blocked',
      { blockedFor: 'tos' },
      'This image is blocked and cannot be rated.',
      /have not been given a NSFW rating/,
    ],
  ])('is not queued while %s', async (_, extra, rateError, approveError) => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R, scanJobs: null, ...extra });

    await expect(rate(NsfwLevel.R)).rejects.toThrow(rateError);
    await expect(approve()).rejects.toThrow(approveError);

    expect((await imageRow()).ingestion).toBe('Scanned');
    expect(await queuedScans()).toEqual([]);
  });

  it('is not queued from another collection', async () => {
    await seed({
      ingestion: 'Scanned',
      nsfwLevel: NsfwLevel.R,
      scanJobs: null,
      postCollectionId: OTHER_COLLECTION_ID,
    });

    await expect(approve()).rejects.toThrow();

    expect(await queuedScans()).toEqual([]);
  });

  it.each(['Error', 'NotFound'])(
    'tells the judge when the scan ended %s, and queues nothing',
    async (ingestion) => {
      await seed({
        ingestion,
        nsfwLevel: 0,
        scanJobs: '{"workflowId": "wf-1", "retryCount": 9}',
      });

      await expect(rate(NsfwLevel.R)).rejects.toThrow(
        'The scan failed for this image; ask a moderator.'
      );
      await expect(approve()).rejects.toThrow(
        'The scan failed for some of the items selected; ask a moderator.'
      );
      expect((await imageRow()).ingestion).toBe(ingestion);
      expect(await queuedScans()).toEqual([]);
    }
  );

  it('says held before it says scanning', async () => {
    await seed({ ingestion: 'Pending', nsfwLevel: 0, scanJobs: null, needsReview: 'poi' });

    await expect(rate(NsfwLevel.R)).rejects.toThrow('This image is waiting for moderator review.');
    await expect(approve()).rejects.toThrow(
      'Some of the items selected are waiting for moderator review.'
    );
  });

  it('marks a never-scanned image that is out of scan retries as failed instead of queuing it', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R, scanJobs: '{"retryCount": 9}' });

    await expect(rate(NsfwLevel.R)).rejects.toThrow(
      'The scan failed for this image; ask a moderator.'
    );

    expect((await imageRow()).ingestion).toBe('Error');
    expect(await queuedScans()).toEqual([]);
  });

  it('a rescan that rates lower ends at the level the judges applied, still unapproved', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R, scanJobs: null });
    await expect(rate(NsfwLevel.R)).rejects.toThrow(/still being scanned/i);

    // The scan's verdict (PG13) with its judge floor, as resolveScanOutcome writes it.
    await raw.executeRaw`
      UPDATE "Image" SET ingestion = 'Scanned', "scanJobs" = '{"workflowId": "wf-2"}',
        "nsfwLevel" = GREATEST(${NsfwLevel.PG13}::int, ${judgeRatingFloorSql()})
    `;

    expect((await imageRow()).nsfwLevel).toBe(NsfwLevel.R);
    await expect(approve()).rejects.toThrow(/NSFW rating/);
  });

  it('leaves an image whose first scan is still running alone', async () => {
    await seed({ ingestion: 'Pending', nsfwLevel: 0, scanJobs: null });

    await expect(rate(NsfwLevel.R)).rejects.toThrow(/still being scanned/i);

    expect((await imageRow()).ingestion).toBe('Pending');
    expect(await queuedScans()).toEqual([]);
  });
});

describe('approving a judge-rated item held for moderator review', () => {
  it('is refused as waiting for moderator review', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R });
    await rate(NsfwLevel.R);
    await db.exec(`UPDATE "Image" SET "needsReview" = 'minor'`);

    await expect(approve()).rejects.toThrow(
      'Some of the items selected are waiting for moderator review.'
    );
  });

  it('goes ahead once the hold is cleared', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R });
    await rate(NsfwLevel.R);
    await db.exec(`UPDATE "Image" SET "needsReview" = 'minor'`);
    await db.exec(`UPDATE "Image" SET "needsReview" = NULL`);

    await expect(approve()).rejects.toThrow(PAST_GATE);
  });
});

describe('a legacy judge rating', () => {
  const LEGACY = {
    judgeRating: { userId: null, nsfwLevel: 4, legacy: true, collectionId: COLLECTION_ID },
  };

  it('is replaced by a judge rating, which then approves', async () => {
    await seed({ ingestion: 'Scanned', nsfwLevel: NsfwLevel.R });
    await db.query(`UPDATE "Image" SET metadata = $1`, [LEGACY]);
    await expect(approve()).rejects.toThrow(/NSFW rating/);

    await rate(NsfwLevel.R);

    expect((await imageRow()).metadata?.judgeRating).toMatchObject({ userId: JUDGE_ID });
    expect((await imageRow()).metadata?.judgeRating).not.toHaveProperty('legacy');
    await expect(approve()).rejects.toThrow(PAST_GATE);
  });
});
