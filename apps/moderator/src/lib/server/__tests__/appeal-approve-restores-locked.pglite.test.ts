import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Effects from '../image-moderation-effects';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle, chQuery, chInsert } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  chQuery: vi.fn(),
  chInsert: vi.fn(async () => undefined),
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
  refundAppealFee: vi.fn(async () => undefined),
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
}));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../thumbnail-cache', () => ({ invalidateThumbnails: vi.fn(async () => undefined) }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ query: chQuery, insert: chInsert }) }));

const { acceptImage, resolveImageAppeal } = await import('../image-moderation.service');

// The stand-in keeps the real function's skip of nsfwLevelLocked rows; without it the reset assertions pass vacuously.
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
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER);
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
  "buzzTransactionId" TEXT,
  "entityRemovedAt" TIMESTAMP(3)
);
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$
  UPDATE "Image" SET "nsfwLevel" = 1
  WHERE id = ANY(ids) AND NOT "nsfwLevelLocked" AND "ingestion" = 'Scanned' AND "blockedFor" IS NULL;
$$;
`;

const IMAGE_ID = 41;
const PHASH = '1234567890';

let db: PGlite;

beforeEach(async () => {
  chQuery.mockReset();
  chQuery.mockResolvedValue({ json: async () => [{ hash: PHASH, reason: 'TOS' }] });
  chInsert.mockClear();
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.query(
    `INSERT INTO "Image" ("id", "needsReview", "blockedFor", "ingestion", "pHash", "nsfwLevel", "nsfwLevelLocked")
     VALUES ($1, 'appeal', 'moderated', 'Blocked', $2, 32, TRUE)`,
    [IMAGE_ID, PHASH]
  );
  await db.query(
    `INSERT INTO "Appeal" ("userId", "entityType", "entityId") VALUES (7, 'Image', $1)`,
    [IMAGE_ID]
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const imageRow = async () =>
  (
    await db.query<{ ingestion: string; nsfwLevel: number; nsfwLevelLocked: boolean }>(
      `SELECT "ingestion", "nsfwLevel", "nsfwLevelLocked" FROM "Image" WHERE "id" = $1`,
      [IMAGE_ID]
    )
  ).rows[0];

const unblocklisted = () =>
  chInsert.mock.calls.flatMap(
    (args) => ((args as unknown[])[0] as { values: { hash: string; disabled?: boolean }[] }).values
  );

const approve = () =>
  resolveImageAppeal({
    imageId: IMAGE_ID,
    status: 'Approved',
    resolvedReason: 'misclassified',
    userId: 2,
  });

describe('approving an appeal on a rating-locked Blocked image', () => {
  it('resets the Blocked level so the recompute restores the real one', async () => {
    await approve();

    expect(await imageRow()).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 1,
      nsfwLevelLocked: false,
    });
  });

  it('takes the pHash off the blocklist', async () => {
    await approve();

    expect(unblocklisted()).toEqual([{ hash: PHASH, reason: 'TOS', disabled: true }]);
  });

  it('restores the same row acceptImage does', async () => {
    await acceptImage({ imageId: IMAGE_ID, userId: 2 });
    const accepted = await imageRow();
    await db.query(
      `UPDATE "Image" SET "needsReview" = 'appeal', "blockedFor" = 'moderated', "ingestion" = 'Blocked',
         "nsfwLevel" = 32, "nsfwLevelLocked" = TRUE WHERE "id" = $1`,
      [IMAGE_ID]
    );
    await db.query(
      `INSERT INTO "Appeal" ("userId", "entityType", "entityId") VALUES (7, 'Image', $1)`,
      [IMAGE_ID]
    );

    await approve();

    expect(await imageRow()).toEqual(accepted);
  });
});

describe('rejecting an appeal on a rating-locked Blocked image', () => {
  it('leaves the level, the lock and the blocklist alone', async () => {
    await resolveImageAppeal({
      imageId: IMAGE_ID,
      status: 'Rejected',
      resolvedReason: 'violation-confirmed',
      userId: 2,
    });

    expect(await imageRow()).toEqual({
      ingestion: 'Blocked',
      nsfwLevel: 32,
      nsfwLevelLocked: true,
    });
    expect(chInsert).not.toHaveBeenCalled();
  });
});

describe('approving when the moderator-only review flag holds the image', () => {
  it('leaves it Blocked and locked', async () => {
    const { FLAG_KEPT_THROUGH_BLOCK } = await import('$lib/image-review');
    await db.query(`UPDATE "Image" SET "needsReview" = $2 WHERE "id" = $1`, [
      IMAGE_ID,
      FLAG_KEPT_THROUGH_BLOCK,
    ]);

    await approve();

    expect(await imageRow()).toEqual({
      ingestion: 'Blocked',
      nsfwLevel: 32,
      nsfwLevelLocked: true,
    });
    expect(chInsert).not.toHaveBeenCalled();
  });
});
