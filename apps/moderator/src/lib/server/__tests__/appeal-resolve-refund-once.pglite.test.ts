import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Effects from '../image-moderation-effects';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * Two moderators resolving one appeal at once must refund its fee once. Rows are what decide which
 * resolution closed the appeal, so this runs against a real Postgres.
 */

const { dbHandle, refundAppealFee } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  refundAppealFee: vi.fn(async () => undefined),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../image-moderation-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof Effects>()),
  refundAppealFee,
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
  applyAcceptSideEffects: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
}));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../thumbnail-cache', () => ({ invalidateThumbnails: vi.fn(async () => undefined) }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));

const { acceptImage, closedAppellants, resolveImageAppeal } = await import(
  '../image-moderation.service'
);

// Stand-ins cut to the columns the two resolve paths touch.
const SCHEMA = `
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT,
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "email" TEXT, "username" TEXT);
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "resolvedBy" INTEGER,
  "resolvedAt" TIMESTAMP(3),
  "resolvedMessage" TEXT,
  "resolvedReason" TEXT,
  "internalNotes" TEXT,
  "buzzTransactionId" TEXT
);
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
`;

const IMAGE_ID = 41;
const FEE = 'appeal-7-1790000000000-abcd1234';

let db: PGlite;

beforeEach(async () => {
  refundAppealFee.mockClear();
  db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.query(
    `INSERT INTO "Image" ("id", "needsReview", "blockedFor") VALUES ($1, 'appeal', 'moderated')`,
    [IMAGE_ID]
  );
  await db.query(
    `INSERT INTO "Appeal" ("userId", "entityType", "entityId", "buzzTransactionId") VALUES (7, 'Image', $1, $2)`,
    [IMAGE_ID, FEE]
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const appealStatuses = async () =>
  (await db.query<{ status: string }>(`SELECT "status" FROM "Appeal" ORDER BY "id"`)).rows.map(
    ({ status }) => status
  );

const imageRow = async () =>
  (
    await db.query<{
      needsReview: string | null;
      blockedFor: string | null;
      ingestion: string | null;
    }>(`SELECT "needsReview", "blockedFor", "ingestion" FROM "Image" WHERE "id" = $1`, [IMAGE_ID])
  ).rows[0];

const appealLabels = async () =>
  (
    await db.query<{ resolvedReason: string | null; internalNotes: string | null }>(
      `SELECT "resolvedReason", "internalNotes" FROM "Appeal" ORDER BY "id"`
    )
  ).rows;

describe('the ruling reason', () => {
  it('is written to the appeal it closes, with the note', async () => {
    await resolveImageAppeal({
      imageId: IMAGE_ID,
      status: 'Rejected',
      resolvedReason: 'other',
      internalNotes: 'second account of a banned user',
      userId: 2,
    });

    expect(await appealLabels()).toEqual([
      { resolvedReason: 'other', internalNotes: 'second account of a banned user' },
    ]);
  });

  it('is not written by a resolution that lost the race', async () => {
    await db.query(`UPDATE "Appeal" SET "status" = 'Approved', "resolvedReason" = 'misclassified'`);

    await resolveImageAppeal({
      imageId: IMAGE_ID,
      status: 'Rejected',
      resolvedReason: 'violation-confirmed',
      internalNotes: 'late',
      userId: 2,
    });

    expect(await appealLabels()).toEqual([
      { resolvedReason: 'misclassified', internalNotes: null },
    ]);
  });
});

describe('resolving one appeal twice at once', () => {
  it('resolveImageAppeal refunds the fee once', async () => {
    const approve = () =>
      resolveImageAppeal({
        imageId: IMAGE_ID,
        status: 'Approved',
        resolvedReason: 'misclassified',
        userId: 2,
      });

    const closed = await Promise.all([approve(), approve()]);

    expect(refundAppealFee).toHaveBeenCalledTimes(1);
    expect(await appealStatuses()).toEqual(['Approved']);
    // The bulk actions email from these results, so only the winner may report a closed appeal.
    expect(closedAppellants([IMAGE_ID, IMAGE_ID], closed)).toEqual([
      { userId: 7, imageId: IMAGE_ID },
    ]);
    expect(await imageRow()).toEqual({ needsReview: null, blockedFor: null, ingestion: 'Scanned' });
  });

  it('acceptImage refunds the fee once', async () => {
    const accept = () => acceptImage({ imageId: IMAGE_ID, userId: 2 });

    const closed = await Promise.all([accept(), accept()]);

    expect(refundAppealFee).toHaveBeenCalledTimes(1);
    expect(await appealStatuses()).toEqual(['Approved']);
    expect(closedAppellants([IMAGE_ID, IMAGE_ID], closed)).toEqual([
      { userId: 7, imageId: IMAGE_ID },
    ]);
  });

  it('applies no verdict to the image when another resolution already decided the appeal', async () => {
    await db.query(`UPDATE "Appeal" SET "status" = 'Rejected'`);

    const closed = await resolveImageAppeal({
      imageId: IMAGE_ID,
      status: 'Approved',
      resolvedReason: 'misclassified',
      userId: 2,
    });

    expect(closed).toBeUndefined();
    expect(refundAppealFee).not.toHaveBeenCalled();
    expect(await appealStatuses()).toEqual(['Rejected']);
    // Still blocked; only the queue flag is cleared so the card can leave the queue.
    expect(await imageRow()).toEqual({
      needsReview: null,
      blockedFor: 'moderated',
      ingestion: null,
    });
  });

  it('leaves another review queue alone when the decided appeal is resolved again', async () => {
    await db.query(`UPDATE "Appeal" SET "status" = 'Rejected'`);
    await db.query(`UPDATE "Image" SET "needsReview" = 'minor'`);

    await resolveImageAppeal({
      imageId: IMAGE_ID,
      status: 'Approved',
      resolvedReason: 'misclassified',
      userId: 2,
    });

    expect(await imageRow()).toEqual({
      needsReview: 'minor',
      blockedFor: 'moderated',
      ingestion: null,
    });
  });
});
