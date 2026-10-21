import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Effects from '../image-moderation-effects';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** What this app hands the main app's takedown CDN sync, on the committed queue function. */

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
vi.mock('../image-moderation-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof Effects>()),
  applyAcceptSideEffects: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
  trackImageRestore: vi.fn(async () => undefined),
  refundAppealFee: vi.fn(async () => undefined),
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
  bustPostGalleryCaches: vi.fn(async () => undefined),
}));
vi.mock('../redis', () => ({
  getRedis: () => ({ del: vi.fn(async () => 0) }),
  getSysRedis: () => ({ packed: { set: vi.fn(async () => undefined) } }),
}));
vi.mock('../profile-picture-cache', () => ({
  profilePictureUserIds: vi.fn(async () => []),
  bustProfilePictures: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn(), syncSearchIndexBulk: vi.fn() }));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../storage', () => ({
  getStorage: () => ({ deleteObject: vi.fn(async () => undefined) }),
}));

const { acceptImage, resolveImageAppeal } = await import('../image-moderation.service');
const { deleteImagesByIds } = await import('../image-deletion');

const CDN_ACCESS_MIGRATION = path.resolve(
  __dirname,
  '../../../../../../packages/civitai-db-schema/prisma/migrations/20261111120000_cdn_access_sync/migration.sql'
);

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
CREATE TYPE "JobQueueType" AS ENUM ('BlockedImageDelete');
CREATE TABLE "JobQueue" (
  type "JobQueueType" NOT NULL,
  "entityType" "EntityType" NOT NULL,
  "entityId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  data JSONB,
  PRIMARY KEY ("entityType", "entityId", type)
);
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "publishedAt" TIMESTAMP(3), "metadata" JSONB);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "activity" TEXT, "entityType" TEXT, "entityId" INTEGER
);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT,
  "userId" INTEGER,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT,
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "scannedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE "CollectionItem" ("imageId" INTEGER);
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
  "buzzTransactionId" TEXT,
  "entityRemovedAt" TIMESTAMP(3)
);
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
`;

const OWNER = 7;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(readFileSync(CDN_ACCESS_MIGRATION, 'utf8'));
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const blockedImage = async (id: number, needsReview: string | null = null) => {
  await db.query(
    `INSERT INTO "Image" ("id", "url", "userId", "needsReview", "blockedFor", "ingestion")
     VALUES ($1, $2, $3, $4, 'moderated', 'Blocked')`,
    [id, uuid(id), OWNER, needsReview]
  );
  await db.query(
    `INSERT INTO "JobQueue" (type, "entityType", "entityId") VALUES ('BlockedImageDelete', 'Image', $1)`,
    [id]
  );
};

const queueRow = async (type: string, id: number) =>
  (
    await db.query<{ data: Record<string, unknown> | null }>(
      `SELECT data FROM "JobQueue" WHERE type = $1::"JobQueueType" AND "entityId" = $2`,
      [type, id]
    )
  ).rows[0];

describe('a moderator delete', () => {
  it('queues the url, its owner and whether it was flagged for CSAM review', async () => {
    await blockedImage(1, 'csam');
    await blockedImage(2);

    await deleteImagesByIds([1, 2]);

    const payload = async (id: number) => {
      const { seq: _seq, ...rest } = (await queueRow('CdnAccessSync', id))?.data ?? {};
      return rest;
    };
    expect(await payload(1)).toEqual({
      url: uuid(1),
      userId: OWNER,
      csamReview: true,
      moderatorDelete: true,
    });
    expect(await payload(2)).toEqual({
      url: uuid(2),
      userId: OWNER,
      csamReview: false,
      moderatorDelete: true,
    });
  });
});

describe('an un-block', () => {
  it('drops the pending-delete row when a moderator accepts the image', async () => {
    await blockedImage(1);
    expect(await queueRow('BlockedImageDelete', 1)).toBeDefined();

    await acceptImage({ imageId: 1, userId: 2, restoreRemoved: true });

    expect(await queueRow('BlockedImageDelete', 1)).toBeUndefined();
  });

  it('drops the pending-delete row when an appeal is approved', async () => {
    await blockedImage(1, 'appeal');
    await db.query(
      `INSERT INTO "Appeal" ("userId", "entityType", "entityId") VALUES ($1, 'Image', 1)`,
      [OWNER]
    );

    await resolveImageAppeal({
      imageId: 1,
      status: 'Approved',
      resolvedReason: 'misclassified',
      userId: 2,
    });

    expect(await queueRow('BlockedImageDelete', 1)).toBeUndefined();
  });

  it('keeps the pending-delete row when the appeal is rejected', async () => {
    await blockedImage(1, 'appeal');
    await db.query(
      `INSERT INTO "Appeal" ("userId", "entityType", "entityId") VALUES ($1, 'Image', 1)`,
      [OWNER]
    );

    await resolveImageAppeal({
      imageId: 1,
      status: 'Rejected',
      resolvedReason: 'upheld',
      userId: 2,
    });

    expect(await queueRow('BlockedImageDelete', 1)).toBeDefined();
  });
});
