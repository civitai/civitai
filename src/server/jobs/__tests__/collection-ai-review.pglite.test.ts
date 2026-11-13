import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionReviewService from '~/server/services/ai/collection-review.service';
import type * as CollectionService from '~/server/services/collection.service';
import type * as TrackerModule from '~/server/clickhouse/tracker';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type { CollectionAiReviewSchema } from '~/server/schema/collection.schema';

/**
 * The claim in `applyOutcomes` against real Postgres rows, with an image re-rated between the
 * batch select and the claim. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { reviewImage, updateCollectionItemsStatus } = vi.hoisted(() => ({
  reviewImage: vi.fn(),
  updateCollectionItemsStatus: vi.fn(),
}));

vi.mock('~/server/services/ai/collection-review.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionReviewService>()),
  reviewImage,
}));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  updateCollectionItemsStatus,
}));
vi.mock('~/server/clickhouse/tracker', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackerModule>()),
  Tracker: class {
    collectionAiReview = vi.fn();
  },
}));
vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: () => 'https://image.example/x.jpeg',
}));

const { reviewCollection } = await import('~/server/jobs/collection-ai-review');

const COLLECTION_ID = 42;
const PG = 1;
const PG13 = 2;
const R = 4;

const config: CollectionAiReviewSchema = {
  enabled: true,
  model: 'xiaomi/mimo-v2.6-flash',
  prompt: 'review',
  allowedNsfwLevels: PG | PG13,
  escalationAction: 'reject',
  dryRun: false,
};

const clean = {
  sexualContent: false,
  isPhotorealistic: false,
  suggestiveStyling: false,
  nsfwEstimate: 'PG',
  depictsMinor: false,
  minorIsPhotorealistic: false,
  minorInappropriate: false,
  depictsRealPerson: false,
  otherViolations: [],
  hasBuzzReference: true,
};

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Rescan');
    CREATE TABLE "Collection" (id int PRIMARY KEY, type text NOT NULL, metadata jsonb NOT NULL);
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      url text NOT NULL DEFAULT 'abc',
      type text NOT NULL DEFAULT 'image',
      "nsfwLevel" int NOT NULL,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "blockedFor" text,
      "scanJobs" jsonb,
      metadata jsonb,
      meta jsonb,
      "needsReview" text,
      "postId" int,
      minor boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false,
      "updatedAt" timestamp(3)
    );
    CREATE TABLE "CollectionItem" (
      id int PRIMARY KEY,
      "collectionId" int NOT NULL,
      "imageId" int NOT NULL REFERENCES "Image"(id),
      status text NOT NULL DEFAULT 'REVIEW',
      "reviewedById" int,
      "reviewedAt" timestamp(3),
      "updatedAt" timestamp(3)
    );
  `);
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});
afterAll(() => db.close());

beforeEach(async () => {
  reviewImage.mockReset();
  updateCollectionItemsStatus.mockReset();
  await db.exec(`DELETE FROM "CollectionItem"; DELETE FROM "Image"; DELETE FROM "Collection";`);
});

async function seed(items: { id: number; nsfwLevel: number }[]) {
  for (const { id, nsfwLevel } of items) {
    await db.query(`INSERT INTO "Image" (id, "nsfwLevel") VALUES ($1, $2)`, [id, nsfwLevel]);
    await db.query(
      `INSERT INTO "CollectionItem" (id, "collectionId", "imageId") VALUES ($1, $2, $1)`,
      [id, COLLECTION_ID]
    );
  }
}

const rerate = (imageId: number, nsfwLevel: number) =>
  db.query(`UPDATE "Image" SET "nsfwLevel" = $2 WHERE id = $1`, [imageId, nsfwLevel]);

const claimedIds = async () =>
  (
    await db.query<{ id: number }>(
      `SELECT id FROM "CollectionItem" WHERE "reviewedById" IS NOT NULL ORDER BY id`
    )
  ).rows.map((row) => row.id);

const statusWrites = () =>
  updateCollectionItemsStatus.mock.calls.map((call) => ({
    status: call[0].input.status as string,
    ids: call[0].input.collectionItemIds as number[],
  }));

describe('reviewCollection: an image re-rated before its outcome is written', () => {
  it('leaves an accept unclaimed when the image was re-rated, and accepts the rest', async () => {
    await seed([
      { id: 1, nsfwLevel: PG },
      { id: 2, nsfwLevel: PG },
    ]);
    // Re-rated to a level the collection still allows: the accept was decided on another level.
    reviewImage.mockImplementation(async ({ imageUrl }: { imageUrl: string }) => {
      if (reviewImage.mock.calls.length === 1) await rerate(1, PG13);
      return { observations: clean, usage: { promptTokens: 1, completionTokens: 1 }, imageUrl };
    });

    await reviewCollection(COLLECTION_ID, config);

    expect(await claimedIds()).toEqual([2]);
    expect(statusWrites()).toEqual([{ status: 'ACCEPTED', ids: [2] }]);
  });

  it('leaves a rejection for a disallowed level unclaimed when the image was re-rated', async () => {
    await seed([
      { id: 1, nsfwLevel: PG },
      { id: 2, nsfwLevel: R },
      { id: 3, nsfwLevel: R },
    ]);
    // Item 2 is rejected on its level without a model call; the model call for item 1 is the
    // window in which a moderator corrects that level.
    reviewImage.mockImplementation(async () => {
      await rerate(2, PG);
      return { observations: clean, usage: { promptTokens: 1, completionTokens: 1 } };
    });

    await reviewCollection(COLLECTION_ID, config);

    expect(await claimedIds()).toEqual([1, 3]);
    expect(statusWrites()).toEqual([
      { status: 'ACCEPTED', ids: [1] },
      { status: 'REJECTED', ids: [3] },
    ]);
  });

  it('still claims a finding against the content when the image was re-rated', async () => {
    await seed([{ id: 1, nsfwLevel: PG }]);
    reviewImage.mockImplementation(async () => {
      await rerate(1, PG13);
      return {
        observations: { ...clean, hasBuzzReference: false },
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    });

    await reviewCollection(COLLECTION_ID, config);

    expect(await claimedIds()).toEqual([1]);
    expect(statusWrites()).toEqual([{ status: 'REJECTED', ids: [1] }]);
  });
});

describe('reviewCollection: an image flagged as a minor before its outcome is written', () => {
  it('leaves the accept unclaimed, and accepts the rest', async () => {
    await seed([
      { id: 1, nsfwLevel: PG },
      { id: 2, nsfwLevel: PG },
      { id: 3, nsfwLevel: PG },
      { id: 4, nsfwLevel: PG },
    ]);
    reviewImage.mockImplementation(async () => {
      if (reviewImage.mock.calls.length === 1) {
        await db.query(`UPDATE "Image" SET minor = true WHERE id = 1`);
        await db.query(`UPDATE "Image" SET minor = true, "acceptableMinor" = true WHERE id = 3`);
        await db.query(`UPDATE "Image" SET "acceptableMinor" = true WHERE id = 4`);
      }
      return { observations: clean, usage: { promptTokens: 1, completionTokens: 1 } };
    });

    await reviewCollection(COLLECTION_ID, config);

    expect(await claimedIds()).toEqual([2]);
    expect(statusWrites()).toEqual([{ status: 'ACCEPTED', ids: [2] }]);
  });

  it('holds it for a human on the next run', async () => {
    await seed([{ id: 1, nsfwLevel: PG }]);
    await db.query(`UPDATE "Image" SET minor = true WHERE id = 1`);
    reviewImage.mockResolvedValue({
      observations: clean,
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    await reviewCollection(COLLECTION_ID, config);

    expect(await claimedIds()).toEqual([1]);
    expect(statusWrites()).toEqual([]);
    const image = await db.query<{ needsReview: string | null }>(
      `SELECT "needsReview" FROM "Image" WHERE id = 1`
    );
    expect(image.rows[0].needsReview).toBe('minor');
  });

  // Alongside an accept, so the claim carries the accept-only re-check.
  it('still claims and rejects it for a real violation', async () => {
    await seed([
      { id: 1, nsfwLevel: PG },
      { id: 2, nsfwLevel: PG },
    ]);
    await db.query(`UPDATE "Image" SET minor = true WHERE id = 1`);
    reviewImage.mockImplementation(async () => ({
      observations:
        reviewImage.mock.calls.length === 1 ? { ...clean, depictsRealPerson: true } : clean,
      usage: { promptTokens: 1, completionTokens: 1 },
    }));

    await reviewCollection(COLLECTION_ID, config);

    expect(await claimedIds()).toEqual([1, 2]);
    expect(statusWrites()).toEqual([
      { status: 'ACCEPTED', ids: [2] },
      { status: 'REJECTED', ids: [1] },
    ]);
  });
});

describe('reviewCollection: a collection whose judges apply the rating', () => {
  const judgeRated = (ids: number[], extra = '') =>
    db.exec(`
      UPDATE "Image" SET "scanJobs" = '{"workflowId": "wf"}',
        metadata = jsonb_build_object('judgeRating',
          jsonb_build_object('collectionId', ${COLLECTION_ID}${extra}))
      WHERE id IN (${ids.join(',')});
    `);

  beforeEach(async () => {
    await db.exec(`
      INSERT INTO "Collection" VALUES (${COLLECTION_ID}, 'Image', '{"judgesApplyBrowsingLevel": true}');
    `);
    reviewImage.mockResolvedValue({
      observations: clean,
      usage: { promptTokens: 1, completionTokens: 1 },
    });
  });

  it('leaves an item no judge rated in REVIEW, unreviewed, and accepts the rated ones', async () => {
    await seed([
      { id: 1, nsfwLevel: PG },
      { id: 2, nsfwLevel: PG },
      { id: 3, nsfwLevel: PG },
    ]);
    await judgeRated([1, 3]);

    await reviewCollection(COLLECTION_ID, config);

    expect(await claimedIds()).toEqual([1, 3]);
    expect(statusWrites()).toEqual([{ status: 'ACCEPTED', ids: [1, 3] }]);
    expect(reviewImage).toHaveBeenCalledTimes(2);
  });

  it('does not classify an unrated item again on the next run', async () => {
    await seed([
      { id: 1, nsfwLevel: PG },
      { id: 2, nsfwLevel: PG },
    ]);
    await judgeRated([1]);

    await reviewCollection(COLLECTION_ID, config);
    await reviewCollection(COLLECTION_ID, config);

    expect(reviewImage).toHaveBeenCalledTimes(1);
  });

  it('does not select a judge-rated item held for moderator review', async () => {
    await seed([
      { id: 1, nsfwLevel: PG },
      { id: 2, nsfwLevel: PG },
    ]);
    await judgeRated([1, 2]);
    await db.exec(`UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 1`);

    await reviewCollection(COLLECTION_ID, config);

    expect(await claimedIds()).toEqual([2]);
    expect(statusWrites()).toEqual([{ status: 'ACCEPTED', ids: [2] }]);
    expect(reviewImage).toHaveBeenCalledTimes(1);
  });

  it('does not accept a judge-rated item held for review after it was classified', async () => {
    await seed([
      { id: 1, nsfwLevel: PG },
      { id: 2, nsfwLevel: PG },
    ]);
    await judgeRated([1, 2]);
    reviewImage.mockImplementationOnce(async () => {
      await db.exec(`UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 1`);
      return { observations: clean, usage: { promptTokens: 1, completionTokens: 1 } };
    });

    await reviewCollection(COLLECTION_ID, config);

    expect(await claimedIds()).toEqual([2]);
    expect(statusWrites()).toEqual([{ status: 'ACCEPTED', ids: [2] }]);
  });

  it('does not accept an item carrying only a legacy rating', async () => {
    await seed([{ id: 1, nsfwLevel: PG }]);
    await judgeRated([1], `, 'legacy', true`);

    await reviewCollection(COLLECTION_ID, config);

    expect(reviewImage).not.toHaveBeenCalled();
    expect(statusWrites()).toEqual([]);
  });
});
