import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Effects from '../image-moderation-effects';
import type * as Axiom from '../axiom';
import type * as ProfilePictureCache from '../profile-picture-cache';
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
vi.mock('../storage', () => ({
  getStorage: () => ({ deleteObject: vi.fn(async () => undefined) }),
}));

const { acceptImage, resolveImageAppeal } = await import('../image-moderation.service');
const { deleteImageRows } = await import('../image-deletion');
const { moderateArticle } = await import('../article-moderation');

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
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "details" JSONB NOT NULL DEFAULT '{}',
  "images" JSONB NOT NULL DEFAULT '[]', "reportSentAt" TIMESTAMP(3), "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "email" TEXT, "username" TEXT, "profilePictureId" INTEGER);
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
CREATE TABLE "Article" ("id" INTEGER PRIMARY KEY, "coverId" INTEGER, "userId" INTEGER);
CREATE TABLE "File" ("entityId" INTEGER, "entityType" TEXT);
CREATE TABLE "ImageConnection" ("imageId" INTEGER, "entityId" INTEGER, "entityType" TEXT);
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
`;

const OWNER = 7;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let db: PGlite;
let statements: { sql: string; connection: number }[] = [];

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(readFileSync(CDN_ACCESS_MIGRATION, 'utf8'));
  statements = [];
  let active = 0;
  // Each statement with the connection it ran on: PGlite is one session, so only the connection id
  // tells a transaction's statements from one run beside it on the pool.
  const recording = {
    query: (sql: string, params: unknown[]) => {
      statements.push({ sql, connection: active });
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

    await (dbHandle.current as Kysely<never>)
      .transaction()
      .execute((trx) => deleteImageRows(trx as never, [1, 2]));

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

const failQueueingFor = (imageId: number) =>
  db.exec(`
    CREATE OR REPLACE FUNCTION queue_cdn_access_sync(entity_id integer, entity_type text, payload jsonb)
    RETURNS void AS $$
    BEGIN
      IF entity_id = ${imageId} THEN RAISE EXCEPTION 'queue unavailable'; END IF;
      INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
      VALUES (entity_id, entity_type::"EntityType", 'CdnAccessSync'::"JobQueueType", payload)
      ON CONFLICT ("entityType", "entityId", "type") DO UPDATE
        SET "data" = COALESCE("JobQueue"."data", '{}'::jsonb) || EXCLUDED."data";
    END; $$ LANGUAGE plpgsql;
  `);
const connect = (imageId: number, entityId: number, entityType = 'Article') =>
  db.query(
    `INSERT INTO "ImageConnection" ("imageId", "entityId", "entityType") VALUES ($1, $2, $3)`,
    [imageId, entityId, entityType]
  );
/** The connection `begin` ran on, and the connections of the statements matching `pattern`. */
const connectionsOf = (pattern: RegExp) => ({
  transaction: statements.find((s) => s.sql.trim().toLowerCase() === 'begin')?.connection,
  matching: statements.filter((s) => pattern.test(s.sql)).map((s) => s.connection),
});
const failQueueing = () =>
  db.exec(`
    CREATE OR REPLACE FUNCTION queue_cdn_access_sync(entity_id integer, entity_type text, payload jsonb)
    RETURNS void AS $$ BEGIN RAISE EXCEPTION 'queue unavailable'; END; $$ LANGUAGE plpgsql;
  `);
const imageExists = async (id: number) =>
  (await db.query(`SELECT 1 FROM "Image" WHERE id = $1`, [id])).rows.length === 1;
const articleWithCover = async (articleId: number, coverId: number) => {
  await blockedImage(coverId);
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

describe('a delete whose follow-up cannot be queued', () => {
  it('deletes an article and queues its orphaned cover', async () => {
    await articleWithCover(10, 1);

    expect(await moderateArticle({ action: 'delete', articleId: 10, userId: 2 })).toEqual({
      ok: true,
    });

    expect(await articleExists(10)).toBe(false);
    expect(await imageExists(1)).toBe(false);
    expect((await queueRow('CdnAccessSync', 1))?.data).toMatchObject({
      url: uuid(1),
      moderatorDelete: true,
    });
  });

  it('fails an article delete and keeps the article, its connection and its cover', async () => {
    await articleWithCover(10, 1);
    expect(await moderateArticle({ action: 'delete', articleId: 10, userId: 2 })).toEqual({
      ok: true,
    });
    expect((await queueRow('CdnAccessSync', 1))?.data?.moderatorDelete).toBe(true);

    await articleWithCover(11, 2);
    await failQueueing();

    expect(await moderateArticle({ action: 'delete', articleId: 11, userId: 2 })).toMatchObject({
      ok: false,
    });
    expect(await articleExists(11)).toBe(true);
    expect(await imageExists(2)).toBe(true);
    expect(
      (await db.query(`SELECT 1 FROM "ImageConnection" WHERE "entityId" = 11`)).rows
    ).toHaveLength(1);
    expect((await queueRow('CdnAccessSync', 2))?.data?.moderatorDelete).toBeUndefined();
  });
});

describe('an article delete in one transaction', () => {
  it('rolls back the cover already queued when a later image cannot be queued', async () => {
    await articleWithCover(10, 1);
    await blockedImage(2);
    await connect(2, 10);
    await failQueueingFor(2);

    expect(await moderateArticle({ action: 'delete', articleId: 10, userId: 2 })).toMatchObject({
      ok: false,
    });

    expect(await articleExists(10)).toBe(true);
    expect(await imageExists(1)).toBe(true);
    expect(await imageExists(2)).toBe(true);
    expect((await queueRow('CdnAccessSync', 1))?.data?.moderatorDelete).toBeUndefined();
    const { transaction, matching } = connectionsOf(/queue_cdn_access_sync/);
    expect(transaction).toBeDefined();
    expect(matching.length).toBeGreaterThan(0);
    expect(new Set(matching)).toEqual(new Set([transaction]));
  });

  it('reads the avatars on the transaction', async () => {
    await articleWithCover(10, 1);
    await db.query(`INSERT INTO "User" ("id", "profilePictureId") VALUES (5, 1)`);

    expect(await moderateArticle({ action: 'delete', articleId: 10, userId: 2 })).toEqual({
      ok: true,
    });

    const { transaction, matching } = connectionsOf(/from "User"/);
    expect(matching.length).toBeGreaterThan(0);
    expect(new Set(matching)).toEqual(new Set([transaction]));
  });

  it('fails and changes nothing when the avatar read fails', async () => {
    await articleWithCover(10, 1);
    await db.exec(`ALTER TABLE "User" RENAME TO "UserUnavailable"`);

    expect(await moderateArticle({ action: 'delete', articleId: 10, userId: 2 })).toMatchObject({
      ok: false,
    });

    expect(await articleExists(10)).toBe(true);
    expect(await imageExists(1)).toBe(true);
    expect((await queueRow('CdnAccessSync', 1))?.data?.moderatorDelete).toBeUndefined();
  });

  it('deletes an orphaned content image and keeps one another entity still uses', async () => {
    await articleWithCover(10, 1);
    await blockedImage(2);
    await connect(2, 10);
    await blockedImage(3);
    await connect(3, 10);
    await connect(3, 99, 'Bounty');

    expect(await moderateArticle({ action: 'delete', articleId: 10, userId: 2 })).toEqual({
      ok: true,
    });

    expect(await imageExists(2)).toBe(false);
    expect(await imageExists(3)).toBe(true);
    const { transaction, matching } = connectionsOf(/not exists \(select "ImageConnection"/i);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toBe(transaction);
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
