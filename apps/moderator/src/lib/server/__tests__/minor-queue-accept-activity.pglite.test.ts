import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

// PGlite boots a WASM Postgres; under a full parallel run that alone can pass the default hook budget.
vi.setConfig({ hookTimeout: 60_000 });

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
  trackImageRestore: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));

const { acceptImage } = await import('../image-moderation.service');

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT,
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "userId" INTEGER,
  "minor" BOOLEAN NOT NULL DEFAULT FALSE,
  "poi" BOOLEAN NOT NULL DEFAULT FALSE,
  "scannedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER);
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "entityType" "EntityType" NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" "AppealStatus" NOT NULL DEFAULT 'Pending',
  "resolvedBy" INTEGER,
  "resolvedAt" TIMESTAMP(3),
  "resolvedMessage" TEXT,
  "resolvedReason" TEXT,
  "internalNotes" TEXT,
  "buzzTransactionId" TEXT,
  "entityRemovedAt" TIMESTAMP(3)
);
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
-- The local dump's unique key: a second, different activity on the same image must still land.
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
  "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  UNIQUE ("activity", "entityType", "entityId")
);
`;

const MOD = 2;
const MINOR_R = 61; // minor queue, minor flagged, R-rated
const MINOR_PG = 62; // minor queue, minor flagged, PG
const MINOR_UNFLAGGED = 63; // minor queue, minor already false
const TAG_QUEUE = 64; // another queue, minor flagged

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

beforeEach(async () => {
  await db.exec(`TRUNCATE "Image", "Appeal", "ModActivity"`);
  await db.query(
    `INSERT INTO "Image" ("id", "userId", "needsReview", "ingestion", "minor", "nsfwLevel") VALUES
      ($1, 7, 'minor', 'Scanned', TRUE, 4),
      ($2, 7, 'minor', 'Scanned', TRUE, 1),
      ($3, 7, 'minor', 'Scanned', FALSE, 1),
      ($4, 7, 'tag', 'Scanned', TRUE, 1)`,
    [MINOR_R, MINOR_PG, MINOR_UNFLAGGED, TAG_QUEUE]
  );
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const activitiesFor = async (imageId: number) =>
  (
    await db.query<{ activity: string; userId: number; entityType: string }>(
      `SELECT "activity", "userId", "entityType" FROM "ModActivity" WHERE "entityId" = $1 ORDER BY "id"`,
      [imageId]
    )
  ).rows;

const minorOf = async (imageId: number) =>
  (await db.query<{ minor: boolean }>(`SELECT "minor" FROM "Image" WHERE "id" = $1`, [imageId]))
    .rows[0].minor;

describe('acceptImage: minor-queue activity', () => {
  it('logs clearMinor when "Accept + clear minor" lifts the flag', async () => {
    await acceptImage({ imageId: MINOR_PG, userId: MOD, removeMinorFlag: true });

    expect(await minorOf(MINOR_PG)).toBe(false);
    expect(await activitiesFor(MINOR_PG)).toEqual([
      { activity: 'review', userId: MOD, entityType: 'image' },
      { activity: 'clearMinor', userId: MOD, entityType: 'image' },
    ]);
  });

  it('logs clearMinor when a plain accept on an R-rated image lifts the flag', async () => {
    await acceptImage({ imageId: MINOR_R, userId: MOD });

    expect(await minorOf(MINOR_R)).toBe(false);
    expect((await activitiesFor(MINOR_R)).map((r) => r.activity)).toEqual(['review', 'clearMinor']);
  });

  it('logs minorQueueAccept when a plain accept leaves the flag on', async () => {
    await acceptImage({ imageId: MINOR_PG, userId: MOD });

    expect(await minorOf(MINOR_PG)).toBe(true);
    expect((await activitiesFor(MINOR_PG)).map((r) => r.activity)).toEqual([
      'review',
      'minorQueueAccept',
    ]);
  });

  it('logs minorQueueAccept, not clearMinor, when there was no flag to lift', async () => {
    await acceptImage({ imageId: MINOR_UNFLAGGED, userId: MOD, removeMinorFlag: true });

    expect((await activitiesFor(MINOR_UNFLAGGED)).map((r) => r.activity)).toEqual([
      'review',
      'minorQueueAccept',
    ]);
  });

  it('logs only review for an accept from another queue', async () => {
    await acceptImage({ imageId: TAG_QUEUE, userId: MOD, removeMinorFlag: true });

    expect(await minorOf(TAG_QUEUE)).toBe(true);
    expect((await activitiesFor(TAG_QUEUE)).map((r) => r.activity)).toEqual(['review']);
  });
});
