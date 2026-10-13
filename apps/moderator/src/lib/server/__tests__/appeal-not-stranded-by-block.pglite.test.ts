import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The appeals queue lists images by `needsReview = 'appeal'`, and the blocked-image purge spares only
 * those rows. A write that clears the flag while the Appeal is still Pending leaves an appeal nobody
 * can reach on an image the purge is free to delete.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

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
vi.mock('../image-moderation-effects', () => ({
  applyBlockSideEffects: vi.fn(async () => undefined),
  applyAcceptSideEffects: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
  refundAppealFee: vi.fn(async () => undefined),
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
}));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));

const { blockImage } = await import('../image-moderation.service');

// Enums as in prod, so a literal outside the enum fails here too.
const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "type" TEXT,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT,
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "userId" INTEGER,
  "updatedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "entityType" "EntityType" NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" "AppealStatus" NOT NULL DEFAULT 'Pending'
);
`;

const APPEALED = 41;
const FLAGGED = 42;
const DECIDED = 43;

let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.query(
    `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel") VALUES
      ($1, 7, 'appeal', 'moderated', 'Blocked', 32),
      ($2, 8, 'minor', NULL, 'Scanned', 4),
      ($3, 9, NULL, 'moderated', 'Blocked', 32)`,
    [APPEALED, FLAGGED, DECIDED]
  );
  // FLAGGED shares its id with a Pending appeal on a post; DECIDED's own appeal is already closed.
  await db.query(
    `INSERT INTO "Appeal" ("userId", "entityType", "entityId", "status") VALUES
      (7, 'Image', $1, 'Pending'), (8, 'Post', $2, 'Pending'), (9, 'Image', $3, 'Rejected')`,
    [APPEALED, FLAGGED, DECIDED]
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

/** Pending image appeals the queue cannot see: the closing condition of the ticket, as a query. */
const strandedAppeals = async () =>
  (
    await db.query<{ id: number; needsReview: string | null }>(
      `SELECT a."entityId" AS id, i."needsReview"
       FROM "Appeal" a JOIN "Image" i ON i.id = a."entityId"
       WHERE a."entityType" = 'Image' AND a."status" = 'Pending'
         AND i."needsReview" IS DISTINCT FROM 'appeal'`
    )
  ).rows;

const imageRow = async (id: number) =>
  (
    await db.query<{ needsReview: string | null; ingestion: string | null }>(
      `SELECT "needsReview", "ingestion" FROM "Image" WHERE "id" = $1`,
      [id]
    )
  ).rows[0];

describe('blocking an image that is under appeal', () => {
  it('does not leave a pending appeal the appeals queue cannot reach', async () => {
    await blockImage({ imageId: APPEALED, userId: 2 });

    expect(await strandedAppeals()).toEqual([]);
    expect((await imageRow(APPEALED)).ingestion).toBe('Blocked');
  });

  it('still clears another review flag on an image with no pending appeal of its own', async () => {
    await blockImage({ imageId: FLAGGED, userId: 2 });

    expect(await imageRow(FLAGGED)).toEqual({ needsReview: null, ingestion: 'Blocked' });
  });

  it('does not put an image whose appeal was already decided back in the appeals queue', async () => {
    await blockImage({ imageId: DECIDED, userId: 2 });

    expect(await imageRow(DECIDED)).toEqual({ needsReview: null, ingestion: 'Blocked' });
  });
});
