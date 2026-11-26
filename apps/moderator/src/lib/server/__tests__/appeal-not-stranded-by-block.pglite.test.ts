import { readFileSync } from 'fs';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  SET_ASIDE_TABLE_SQL,
} from '../../../test/held-image-tables';
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

vi.mock('../removal-hold', () => ({
  // No approved appeals here; the hold itself is covered by image-removal-confirmation.pglite.test.ts.
  holdRemovals: vi.fn(async (requests: { imageId: number }[]) => ({
    held: [],
    proceed: requests.map((r) => r.imageId),
  })),
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
vi.mock('../mod-activity', () => ({
  insertModActivity: vi.fn(async () => 1),
  recordModActivity: vi.fn(async () => undefined),
}));
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
${SET_ASIDE_TABLE_SQL}
${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
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
const CSAM_BLOCKED = 44;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
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

  it('never gives an image holding a CSAM block the appeal flag', async () => {
    await db.query(
      `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel")
       VALUES ($1, 10, NULL, 'CSAM', 'Blocked', 32)`,
      [CSAM_BLOCKED]
    );
    await db.query(
      `INSERT INTO "Appeal" ("userId", "entityType", "entityId", "status") VALUES (10, 'Image', $1, 'Pending')`,
      [CSAM_BLOCKED]
    );
    await blockImage({ imageId: CSAM_BLOCKED, userId: 2 });

    const { needsReview, blockedFor } = (
      await db.query<{ needsReview: string | null; blockedFor: string | null }>(
        `SELECT "needsReview", "blockedFor" FROM "Image" WHERE "id" = $1`,
        [CSAM_BLOCKED]
      )
    ).rows[0];
    // Control: the block kept the CSAM reason.
    expect(blockedFor).toBe('CSAM');
    expect(needsReview).toBeNull();
  });
});

// The main app's kept-delete hide marks the image (metadata.keptHide); its release lifts the hide only
// while the marker is there. The table's trigger drops it from any write naming a block column.
describe('removing an image a kept delete hid', () => {
  const KEPT = 45;
  const marker = async () =>
    (
      await db.query<{ marker: string | null; ingestion: string }>(
        `SELECT "metadata"->>'keptHide' AS marker, "ingestion" FROM "Image" WHERE "id" = $1`,
        [KEPT]
      )
    ).rows[0];
  beforeEach(async () => {
    // Read by a report verdict's already-removed check.
    await db.exec(`
      CREATE TABLE "ModerationRule" ("id" INTEGER PRIMARY KEY, "action" TEXT NOT NULL);
      CREATE TABLE "ModerationRuleVersion" ("ruleId" INTEGER NOT NULL, "action" TEXT NOT NULL);
      CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "bannedAt" TIMESTAMP(3));
    `);
    await db.exec(
      readFileSync(
        `${__dirname}/../../../../../../packages/civitai-db-schema/prisma/migrations/20271203120000_image_kept_hide_marker_drop/migration.sql`,
        'utf8'
      )
    );
    await db.query(
      `INSERT INTO "Image" ("id", "userId", "blockedFor", "ingestion", "nsfwLevel", "metadata") VALUES
        ($1, 11, 'moderated', 'Blocked', 32, '{"keptHide": "h1"}')`,
      [KEPT]
    );
  });

  it.each([
    ['a report verdict', { skipModeratorRemoved: true }],
    ['a direct remove', {}],
  ])('blocks it for real on %s, which drops the marker', async (_, options) => {
    const result = await blockImage({ imageId: KEPT, userId: 2, ...options });

    expect(result.alreadyRemoved).toBeUndefined();
    expect(await marker()).toEqual({ marker: null, ingestion: 'Blocked' });
  });

  it('control: a report verdict leaves a moderator-removed image without the marker as it is', async () => {
    await db.query(`UPDATE "Image" SET "metadata" = '{}' WHERE "id" = $1`, [KEPT]);

    const result = await blockImage({ imageId: KEPT, userId: 2, skipModeratorRemoved: true });

    expect(result.alreadyRemoved).toBe(true);
  });
});
