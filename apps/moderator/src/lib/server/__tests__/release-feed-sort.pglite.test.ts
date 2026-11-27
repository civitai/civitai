import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A moderator's Accept on a held image moves it in the feeds only when the release is its first
 * showing, through firstVisibleAt and its 7-day cap. Run against the real sort triggers.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../removal-hold', () => ({
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
  trackImageRestore: vi.fn(async () => undefined),
}));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
// The models-index requeue is covered in image-models-reindex.pglite.test.ts; this schema has no Post table.
vi.mock('../image-models-reindex', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
}));

// The article lookup is covered in article-cover-reindex.pglite.test.ts; this schema has no Article table.
vi.mock('../article-cover-reindex', () => ({
  queueArticlesForCoverImages: vi.fn(async () => undefined),
}));

const { acceptImage } = await import('../image-moderation.service');

const TRIGGERS = path.resolve(
  __dirname,
  '../../../../../../packages/civitai-db-schema/prisma/programmability/image_post_triggers.sql'
);

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
CREATE DOMAIN "ImageIngestionStatus" AS TEXT;
CREATE TABLE "ModerationRule" ("id" INTEGER PRIMARY KEY, "action" TEXT NOT NULL);
CREATE TABLE "ModerationRuleVersion" ("ruleId" INTEGER, "action" TEXT);
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "publishedAt" TIMESTAMP(3));
CREATE TABLE "Image" (
  "id" SERIAL PRIMARY KEY,
  "type" TEXT,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" "ImageIngestionStatus",
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "userId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE,
  "minor" BOOLEAN NOT NULL DEFAULT FALSE,
  "poi" BOOLEAN NOT NULL DEFAULT FALSE,
  "acceptableMinor" BOOLEAN NOT NULL DEFAULT FALSE,
  "modelRestricted" BOOLEAN NOT NULL DEFAULT FALSE,
  "tosViolation" BOOLEAN NOT NULL DEFAULT FALSE,
  "scannedAt" TIMESTAMP(3),
  "sortAt" TIMESTAMP(3),
  "firstVisibleAt" TIMESTAMP(3)
);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER, "data" JSONB,
  PRIMARY KEY ("entityType", "entityId", "type"));
CREATE TABLE "TagsOnImageDetails" ("imageId" INTEGER, "disabled" BOOLEAN);
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "scanJobs" JSONB;
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
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "deletedAt" TIMESTAMP(3), "bannedAt" TIMESTAMP(3), "email" TEXT, "username" TEXT);
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
CREATE TYPE "CsamQueueSetAsideOutcome" AS ENUM ('AfterReport', 'Dismissed');
CREATE TABLE "CsamQueueSetAside" (
  "imageId" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "outcome" "CsamQueueSetAsideOutcome" NOT NULL,
  "csamReportId" INTEGER,
  "moderatorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
  "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
`;

// Above image_first_visible_min_id(), which the empty sequence puts at 1.
const SERVED = 11; // shown, then held again
const NEVER_SHOWN = 12; // held from upload
const NEVER_HELD = 13;

let db: PGlite;
const pause = () => new Promise((r) => setTimeout(r, 20));
const sortAt = async (id: number) =>
  (
    await db.query<{ sortAt: Date }>(`SELECT "sortAt" FROM "Image" WHERE "id" = $1`, [id])
  ).rows[0].sortAt.getTime();

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`INSERT INTO "User" ("id") VALUES (7);
    INSERT INTO "Post" VALUES (1, now() - interval '2 days');`);
  await db.exec(readFileSync(TRIGGERS, 'utf8'));
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  for (const [id, needsReview] of [
    [SERVED, null],
    [NEVER_SHOWN, 'poi'],
    [NEVER_HELD, null],
  ] as const)
    await db.query(
      `INSERT INTO "Image" ("id", "userId", "postId", "createdAt", "scannedAt", "ingestion", "nsfwLevel", "needsReview", "poi")
       VALUES ($1, 7, 1, now() - interval '2 days', now() - interval '2 days', 'Scanned', 1, $2::text, $2::text IS NOT NULL)`,
      [id, needsReview]
    );
  await pause();
  await db.query(`UPDATE "Image" SET "needsReview" = 'poi', "poi" = TRUE WHERE "id" = $1`, [
    SERVED,
  ]);
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('Accept on a held image and the feed sort', () => {
  it('moves an image first shown by the release, and no other', async () => {
    const { rows: shown } = await db.query<{ id: number }>(
      `SELECT "id" FROM "Image" WHERE "firstVisibleAt" IS NOT NULL ORDER BY "id"`
    );
    expect(shown.map((row) => row.id)).toEqual([SERVED, NEVER_HELD]);
    const before = new Map([SERVED, NEVER_SHOWN, NEVER_HELD].map((id) => [id, 0]));
    for (const id of before.keys()) before.set(id, await sortAt(id));
    await pause();

    const releasedAt = Date.now();
    await acceptImage({ imageId: SERVED, userId: 2 });
    await acceptImage({ imageId: NEVER_SHOWN, userId: 2 });

    expect(await sortAt(SERVED)).toBe(before.get(SERVED));
    expect(await sortAt(NEVER_HELD)).toBe(before.get(NEVER_HELD));
    // Its first showing, within a week of publish: the feed lists it from the release.
    expect(await sortAt(NEVER_SHOWN)).toBeGreaterThanOrEqual(releasedAt - 1000);
  });
});
