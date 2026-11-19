import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { Kysely } from 'kysely';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

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
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ insert: vi.fn(async () => undefined) }),
}));

const { moderateArticle } = await import('../article-moderation');

// The share-link tables as the migration creates them.
const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    '../../../../../../packages/civitai-db-schema/prisma/migrations/20261106090527_access_token/migration.sql'
  ),
  'utf8'
);

const SCHEMA = `
CREATE TYPE "ReportReason" AS ENUM ('NSFW', 'Other');
CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Actioned');
CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'Rescan');
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY);
CREATE TABLE "Article" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "status" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3), "scheduledAt" TIMESTAMP(3), "metadata" JSONB, "coverId" INTEGER, "bannerId" INTEGER, "title" TEXT, "content" TEXT,
  "ingestion" "ArticleIngestionStatus" NOT NULL DEFAULT 'Scanned', "contentScannedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1, "userNsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "moderatorNsfwLevel" INTEGER
);
CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "nsfwLevel" INTEGER, "ingestion" TEXT);
CREATE TABLE "ImageConnection" ("imageId" INTEGER, "entityId" INTEGER, "entityType" TEXT);
CREATE TABLE "EntityModeration" (
  "entityType" TEXT, "entityId" INTEGER, "status" TEXT, "blocked" BOOLEAN, "result" JSONB,
  "triggeredLabels" TEXT[], "nsfwLevel" INTEGER
);
CREATE TABLE "Report" ("id" INTEGER PRIMARY KEY, "reason" "ReportReason", "status" "ReportStatus");
CREATE TABLE "ArticleReport" ("articleId" INTEGER, "reportId" INTEGER);
CREATE TABLE "ArticleContentLinkHold" ("articleId" INTEGER PRIMARY KEY, "deferred" TEXT[], "refused" TEXT[]);
`;

const AUTHOR = 7;
const ARTICLE = 50;
const OTHER_ARTICLE = 51;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION);
  await db.exec(`
    INSERT INTO "User" VALUES (${AUTHOR});
    INSERT INTO "Article" (id, "userId", status, "publishedAt", title, content)
      VALUES (${ARTICLE}, ${AUTHOR}, 'Unpublished', now(), 'Title', ''),
             (${OTHER_ARTICLE}, ${AUTHOR}, 'Unpublished', now(), 'Title', '');
    INSERT INTO "AccessToken" ("resourceType", "resourceId", "tokenHash", "createdById", "expiresAt")
      VALUES ('Article', ${ARTICLE}, 'a', ${AUTHOR}, now() + interval '7 days'),
             ('Article', ${OTHER_ARTICLE}, 'b', ${AUTHOR}, now() + interval '7 days');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const activeLinks = async () =>
  (
    await db.query<{ resourceId: number }>(
      `SELECT "resourceId" FROM "AccessToken" WHERE "revokedAt" IS NULL ORDER BY "resourceId"`
    )
  ).rows.map((r) => r.resourceId);

describe("a moderator's article restore", () => {
  // A share link belongs to the draft. Without this, a link made while the article was unpublished
  // reads it again once the author unpublishes it after the restore.
  it("revokes the restored article's share links, and no other article's", async () => {
    await db.exec(`UPDATE "Article" SET metadata = '{"unpublishedBy":1}' WHERE id = ${ARTICLE}`);
    expect(await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 })).toEqual({
      ok: true,
    });
    expect(
      (await db.query<{ status: string }>(`SELECT status FROM "Article" WHERE id = ${ARTICLE}`))
        .rows[0].status
    ).toBe('Published');
    expect(await activeLinks()).toEqual([OTHER_ARTICLE]);
  });

  const row = async () =>
    (
      await db.query<{ status: string; publishedAt: Date | null; metadata: object }>(
        `SELECT status, "publishedAt", metadata FROM "Article" WHERE id = ${ARTICLE}`
      )
    ).rows[0];

  // A shared draft is text-scanned, and a block moves it to UnpublishedViolation with the status it
  // had. Restoring it as Published would publish an article its author never published.
  it('returns a blocked draft to its author as a draft, not published', async () => {
    await db.exec(`UPDATE "Article" SET status = 'UnpublishedViolation', "publishedAt" = NULL,
      metadata = '{"statusBeforeViolation":"Draft","unpublishedReason":"tos"}' WHERE id = ${ARTICLE}`);
    expect(await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 })).toEqual({
      ok: true,
    });
    expect(await row()).toEqual({ status: 'Draft', publishedAt: null, metadata: {} });
  });

  it('returns a blocked article its author had unpublished to Unpublished', async () => {
    await db.exec(`UPDATE "Article" SET status = 'UnpublishedViolation',
      metadata = '{"statusBeforeViolation":"Unpublished"}' WHERE id = ${ARTICLE}`);
    const { publishedAt } = await row();
    await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 });
    expect(await row()).toEqual({ status: 'Unpublished', publishedAt, metadata: {} });
  });

  // A row blocked before blocks recorded a status: publish it only if it had been published.
  it('returns a never-published blocked article with no recorded status to its author as a draft', async () => {
    await db.exec(`UPDATE "Article" SET status = 'UnpublishedViolation', "publishedAt" = NULL,
      metadata = '{"unpublishedReason":"tos"}' WHERE id = ${ARTICLE}`);
    await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 });
    expect(await row()).toEqual({ status: 'Draft', publishedAt: null, metadata: {} });
  });

  it('restores a once-published blocked article with no recorded status as published', async () => {
    await db.exec(`UPDATE "Article" SET status = 'UnpublishedViolation',
      metadata = '{"unpublishedReason":"tos"}' WHERE id = ${ARTICLE}`);
    const { publishedAt } = await row();
    await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 });
    expect(await row()).toEqual({ status: 'Published', publishedAt, metadata: {} });
  });

  const schedule = async () =>
    (
      await db.query<{ scheduledAt: Date | null }>(
        `SELECT "scheduledAt" FROM "Article" WHERE id = ${ARTICLE}`
      )
    ).rows[0].scheduledAt;

  // A schedule that lapsed while the draft was blocked would publish it on the go-live job's next run.
  it('returns a blocked draft whose schedule has passed to Draft with no schedule', async () => {
    await db.exec(`UPDATE "Article" SET status = 'UnpublishedViolation', "publishedAt" = NULL,
      "scheduledAt" = now() - interval '1 day',
      metadata = '{"statusBeforeViolation":"Draft"}' WHERE id = ${ARTICLE}`);
    await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 });
    expect(await row()).toEqual({ status: 'Draft', publishedAt: null, metadata: {} });
    expect(await schedule()).toBeNull();
  });

  it('returns a blocked draft scheduled for later to Draft with no schedule', async () => {
    await db.exec(`UPDATE "Article" SET status = 'UnpublishedViolation', "publishedAt" = NULL,
      "scheduledAt" = now() + interval '30 days',
      metadata = '{"statusBeforeViolation":"Draft"}' WHERE id = ${ARTICLE}`);
    await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 });
    expect(await schedule()).toBeNull();
  });

  describe('of an article in Unpublished', () => {
    const refused = {
      ok: false,
      error: 'The author unpublished this article; only they can republish it.',
    };
    const unpublishedBy = (metadata: object) =>
      db.exec(`UPDATE "Article" SET status = 'Unpublished',
        metadata = '${JSON.stringify(metadata)}' WHERE id = ${ARTICLE}`);

    it('refuses one its author unpublished, and changes nothing', async () => {
      await unpublishedBy({ unpublishedBy: AUTHOR });
      const before = await row();
      expect(await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 })).toEqual(
        refused
      );
      expect(await row()).toEqual(before);
      expect(await activeLinks()).toEqual([ARTICLE, OTHER_ARTICLE]);
    });

    // Rows from before `unpublishedBy` was written are author unpublishes too.
    it('refuses one with no record of who unpublished it', async () => {
      await unpublishedBy({});
      const before = await row();
      expect(await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 })).toEqual(
        refused
      );
      expect(await row()).toEqual(before);
    });

    it('publishes one a moderator unpublished', async () => {
      await unpublishedBy({ unpublishedBy: 1 });
      expect(await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 })).toEqual({
        ok: true,
      });
      expect((await row()).status).toBe('Published');
    });
  });

  // A Processing article may have no publishedAt yet; its block records that it goes live.
  it('publishes a never-published article whose block recorded Published', async () => {
    await db.exec(`UPDATE "Article" SET status = 'UnpublishedViolation', "publishedAt" = NULL,
      metadata = '{"statusBeforeViolation":"Published"}' WHERE id = ${ARTICLE}`);
    await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 });
    expect((await row()).status).toBe('Published');
  });

  // A moderator's unpublish takes down a published article: a status an earlier block recorded
  // must not send it to its author on the next restore.
  it("restores a moderator's unpublish as published, whatever an earlier block recorded", async () => {
    await db.exec(`UPDATE "Article" SET status = 'Published',
      metadata = '{"statusBeforeViolation":"Draft"}' WHERE id = ${ARTICLE}`);
    const unpublish = await moderateArticle({
      action: 'unpublish',
      articleId: ARTICLE,
      userId: 1,
      reason: 'mature-real-person',
      customMessage: null,
    });
    expect(unpublish).toEqual({ ok: true });
    await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 });
    expect((await row()).status).toBe('Published');
  });

  it('leaves the links alone when the restore is refused', async () => {
    await db.exec(`UPDATE "Article" SET status = 'Published' WHERE id = ${ARTICLE}`);
    expect(await moderateArticle({ action: 'restore', articleId: ARTICLE, userId: 1 })).toEqual({
      ok: false,
      error: 'Article is not unpublished',
    });
    expect(await activeLinks()).toEqual([ARTICLE, OTHER_ARTICLE]);
  });
});
