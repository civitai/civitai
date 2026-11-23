import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import { freshPglite } from '../../../test/pglite';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  SET_ASIDE_TABLE_SQL,
  TEXT_SCAN_HOLD_TABLE_SQL,
} from '../../../test/held-image-tables';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Effects from '../image-moderation-effects';
import type * as Axiom from '../axiom';
import type * as ProfilePictureCache from '../profile-picture-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** What this app hands the main app's takedown CDN sync, on the committed queue function. */

const MODERATOR = { id: 1, isModerator: true };
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
vi.mock('../profile-picture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfilePictureCache>()),
  bustProfilePictures: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn(), syncSearchIndexBulk: vi.fn() }));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ insert: vi.fn(async () => undefined) }),
}));
vi.mock('../axiom', async (importOriginal) => ({
  ...(await importOriginal<typeof Axiom>()),
  logAxiomError: vi.fn(async () => undefined),
}));

const { acceptImage, resolveImageAppeal } = await import('../image-moderation.service');
const { deleteImages } = await import('../image-deletion');
const { moderateArticle } = await import('../article-moderation');

const CDN_ACCESS_MIGRATION = path.resolve(
  __dirname,
  '../../../../../../packages/civitai-db-schema/prisma/migrations/20261111120000_cdn_access_sync/migration.sql'
);

const SCHEMA = `
CREATE DOMAIN "ImageIngestionStatus" AS TEXT;
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
CREATE TYPE "JobQueueType" AS ENUM ('BlockedImageDelete', 'ImageStorageDelete', 'UpdateNsfwLevel', 'PendingDelete');
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
${SET_ASIDE_TABLE_SQL}
${TEXT_SCAN_HOLD_TABLE_SQL}
${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
CREATE TABLE "CollectionItem" ("imageId" INTEGER);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "details" JSONB NOT NULL DEFAULT '{}',
  "images" JSONB NOT NULL DEFAULT '[]', "reportSentAt" TIMESTAMP(3), "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "email" TEXT, "username" TEXT, "profilePictureId" INTEGER, "image" TEXT, "deletedAt" TIMESTAMP(3));
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
CREATE TABLE "Article" ("id" INTEGER PRIMARY KEY, "coverId" INTEGER, "userId" INTEGER, "bannerId" INTEGER);
CREATE TABLE "File" ("entityId" INTEGER, "entityType" TEXT);
CREATE TABLE "ImageConnection" ("imageId" INTEGER, "entityId" INTEGER, "entityType" TEXT);
CREATE TABLE "CommentTopic" ("entityType" TEXT, "entityId" INTEGER);
CREATE TABLE "CommentV3" ("id" INTEGER, "entityType" TEXT, "entityId" INTEGER, "userId" INTEGER, "deletedAt" TIMESTAMP(3));
CREATE TABLE "Thread" (
  "id" INTEGER, "articleId" INTEGER, "parentThreadId" INTEGER, "rootThreadId" INTEGER,
  "commentId" INTEGER, "metadata" JSONB
);
CREATE TABLE "CommentV2" ("id" INTEGER, "userId" INTEGER, "threadId" INTEGER);
-- Rates a restored image as its tags would: an untagged one would go back to the scanner.
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$
  UPDATE "Image" SET "nsfwLevel" = 1
  WHERE id = ANY(ids) AND NOT "nsfwLevelLocked" AND "ingestion" = 'Scanned' AND "blockedFor" IS NULL;
$$;
`;

const OWNER = 7;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let db: PGlite;
let statements: { sql: string; params: unknown[]; connection: number }[] = [];

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(imageUseTablesSql);
  await db.exec(readFileSync(CDN_ACCESS_MIGRATION, 'utf8'));
  statements = [];
  let active = 0;
  // Each statement with the connection it ran on: PGlite is one session, so only the connection id
  // tells a transaction's statements from one run beside it on the pool.
  const recording = {
    query: (sql: string, params: unknown[]) => {
      statements.push({ sql, params, connection: active });
      return db.query(sql, params);
    },
  } as unknown as PGlite;
  dbHandle.current = new Kysely({
    dialect: pgliteDialect(recording, { onQuery: (connection) => (active = connection) }),
  });
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
  it('queues the url and owner of a deleted image, and nothing for one a CSAM review keeps', async () => {
    await blockedImage(1, 'csam');
    await blockedImage(2);
    // Another owner's: image 1 puts its own owner's account on hold.
    await db.query(`UPDATE "Image" SET "userId" = $1 WHERE id = 2`, [OWNER + 1]);

    await deleteImages([1, 2], MODERATOR);

    const payload = async (id: number) => {
      const { seq: _seq, ...rest } = (await queueRow('CdnAccessSync', id))?.data ?? {};
      return rest;
    };
    expect((await queueRow('CdnAccessSync', 1))?.data?.moderatorDelete).toBeUndefined();
    expect(await payload(2)).toEqual({
      url: uuid(2),
      userId: OWNER + 1,
      csamReview: false,
      moderatorDelete: true,
    });
  });
});

/**
 * Refuses every CDN sync row (or only an image's), however it is written: by the delete statement
 * itself or through `queue_cdn_access_sync`.
 */
const refuseCdnQueue = (imageId?: number) =>
  db.exec(`
    CREATE OR REPLACE FUNCTION refuse_cdn_queue() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'queue unavailable'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER refuse_cdn_queue BEFORE INSERT ON "JobQueue" FOR EACH ROW
      WHEN (NEW.type = 'CdnAccessSync' ${
        imageId === undefined ? '' : `AND NEW."entityId" = ${imageId}`
      })
      EXECUTE FUNCTION refuse_cdn_queue();
  `);
const failQueueingFor = (imageId: number) => refuseCdnQueue(imageId);
const connect = (imageId: number, entityId: number, entityType = 'Article') =>
  db.query(
    `INSERT INTO "ImageConnection" ("imageId", "entityId", "entityType") VALUES ($1, $2, $3)`,
    [imageId, entityId, entityType]
  );
/**
 * The connection each `begin` ran on, in order, and the connections of the statements matching
 * `pattern`.
 */
const connectionsOf = (pattern: RegExp) => ({
  transactions: statements
    .filter((s) => s.sql.trim().toLowerCase() === 'begin')
    .map((s) => s.connection),
  matching: statements.filter((s) => pattern.test(s.sql)).map((s) => s.connection),
});
const imageExists = async (id: number) =>
  (await db.query(`SELECT 1 FROM "Image" WHERE id = $1`, [id])).rows.length === 1;
const plainImage = (id: number) =>
  db.query(
    `INSERT INTO "Image" ("id", "url", "userId", "ingestion") VALUES ($1, $2, $3, 'Scanned')`,
    [id, uuid(id), OWNER]
  );
const articleWithCover = async (articleId: number, coverId: number) => {
  await plainImage(coverId);
  await db.query(`INSERT INTO "Article" ("id", "coverId", "userId") VALUES ($1, $2, $3)`, [
    articleId,
    coverId,
    OWNER,
  ]);
  await db.query(
    `INSERT INTO "ImageConnection" ("imageId", "entityId", "entityType") VALUES ($1, $2, 'Article')`,
    [coverId, articleId]
  );
};
const articleExists = async (id: number) =>
  (await db.query(`SELECT 1 FROM "Article" WHERE id = $1`, [id])).rows.length === 1;

describe("a moderator's article delete", () => {
  const queued = async () =>
    (
      await db.query<{ entityId: number; data: unknown }>(
        `SELECT "entityId", data FROM "JobQueue" WHERE type = 'PendingDelete' ORDER BY "entityId"`
      )
    ).rows;

  it('queues its orphaned cover and banner for pending-deletes, and deletes neither itself', async () => {
    await articleWithCover(10, 1);
    await plainImage(3);
    await db.query(`UPDATE "Article" SET "bannerId" = 3 WHERE id = 10`);

    expect(await moderateArticle({ action: 'delete', articleId: 10, userId: 2 })).toEqual({
      ok: true,
    });

    expect(await articleExists(10)).toBe(false);
    expect(await queued()).toEqual([
      { entityId: 1, data: { cleanup: true, moderatorDelete: true } },
      { entityId: 3, data: { cleanup: true, moderatorDelete: true } },
    ]);
    expect(await imageExists(1)).toBe(true);
    expect((await queueRow('CdnAccessSync', 1))?.data?.moderatorDelete).toBeUndefined();
  });

  it('queues them as an owner delete when the moderator wrote the article', async () => {
    await articleWithCover(10, 1);

    expect(await moderateArticle({ action: 'delete', articleId: 10, userId: OWNER })).toEqual({
      ok: true,
    });

    expect(await queued()).toEqual([{ entityId: 1, data: { cleanup: true } }]);
  });

  // Which images qualify is queue-image-deletes.pglite.test.ts; this pins that the delete removes only
  // this article's links before the check, and the lock order.
  it('queues an orphaned content image and not one another entity still uses', async () => {
    await articleWithCover(10, 1);
    await plainImage(2);
    await connect(2, 10);
    await plainImage(3);
    await connect(3, 10);
    await connect(3, 99, 'Bounty');

    expect(await moderateArticle({ action: 'delete', articleId: 10, userId: 2 })).toEqual({
      ok: true,
    });

    expect((await queued()).map((row) => row.entityId)).toEqual([1, 2]);
    // With every candidate locked before anything is deleted: unlocked, two articles deleted
    // together each see the other's uncommitted links and both skip a shared image; after the
    // article's delete, it deadlocks against an image delete (the banner foreign key).
    const lock = statements.findIndex((s) => /for no key update/i.test(s.sql));
    const removeArticle = statements.findIndex((s) => /delete from "Article"/i.test(s.sql));
    const check = statements.findIndex((s) =>
      /insert into "JobQueue"[^]*'PendingDelete'/i.test(s.sql)
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(statements[lock].params).toEqual([1, 2, 3]);
    expect(statements[lock].sql).toMatch(/order by "id"/i);
    expect(lock).toBeLessThan(removeArticle);
    expect(removeArticle).toBeLessThan(check);
  });
});

describe("a moderator's image delete in one transaction", () => {
  it('rolls back the image already queued when a later one cannot be queued', async () => {
    await blockedImage(1);
    await blockedImage(2);
    await failQueueingFor(2);

    await expect(deleteImages([1, 2], MODERATOR)).rejects.toThrow();

    expect(await imageExists(1)).toBe(true);
    expect(await imageExists(2)).toBe(true);
    expect((await queueRow('CdnAccessSync', 1))?.data?.moderatorDelete).toBeUndefined();
    expect(await queueRow('ImageStorageDelete', 1)).toBeUndefined();
  });

  it("reads the avatars on the images' transaction", async () => {
    await blockedImage(1);
    await db.query(`INSERT INTO "User" ("id", "profilePictureId") VALUES (5, 1)`);

    await deleteImages([1], MODERATOR);

    const { transactions, matching } = connectionsOf(/from "User"/i);
    expect(matching.length).toBeGreaterThan(0);
    expect(new Set(matching)).toEqual(new Set([transactions[0]]));
  });

  it('keeps the images when the avatar read fails', async () => {
    await blockedImage(1);
    await db.exec(`ALTER TABLE "User" RENAME TO "UserUnavailable"`);

    await expect(deleteImages([1], MODERATOR)).rejects.toThrow();

    expect(await imageExists(1)).toBe(true);
    expect((await queueRow('CdnAccessSync', 1))?.data?.moderatorDelete).toBeUndefined();
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
