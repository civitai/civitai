import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Axiom from '../axiom';
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
vi.mock('../storage', () => ({ getStorage: () => ({ deleteObject: async () => undefined }) }));
vi.mock('../redis', () => ({
  getRedis: () => ({ del: vi.fn(async () => 0) }),
  getSysRedis: () => ({ packed: { set: vi.fn(async () => undefined) } }),
}));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn(), syncSearchIndexBulk: vi.fn() }));
vi.mock('../image-moderation-effects', () => ({ bustPostGalleryCaches: vi.fn() }));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ insert: vi.fn(async () => undefined) }),
}));
vi.mock('../axiom', async (importOriginal) => ({
  ...(await importOriginal<typeof Axiom>()),
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: vi.fn(async () => undefined),
}));

const { moderateArticle } = await import('../article-moderation');

const SCHEMA = `
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY, "url" TEXT, "userId" INTEGER NOT NULL, "needsReview" TEXT,
  "blockedFor" TEXT, "postId" INTEGER
);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "details" JSONB NOT NULL DEFAULT '{}',
  "images" JSONB NOT NULL DEFAULT '[]', "reportSentAt" TIMESTAMP(3), "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER);
CREATE TABLE "Article" ("id" INTEGER PRIMARY KEY, "coverId" INTEGER, "userId" INTEGER, "bannerId" INTEGER);
CREATE TABLE "File" ("entityId" INTEGER, "entityType" TEXT);
CREATE TABLE "ImageConnection" ("imageId" INTEGER, "entityId" INTEGER, "entityType" TEXT);
CREATE TABLE "Thread" (
  "id" INTEGER PRIMARY KEY,
  "articleId" INTEGER UNIQUE REFERENCES "Article"(id) ON DELETE CASCADE,
  "parentThreadId" INTEGER REFERENCES "Thread"(id) ON DELETE CASCADE,
  "rootThreadId" INTEGER REFERENCES "Thread"(id) ON DELETE CASCADE,
  "commentId" INTEGER, "metadata" JSONB
);
CREATE TABLE "CommentV2" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL,
  "threadId" INTEGER NOT NULL REFERENCES "Thread"(id) ON DELETE CASCADE
);
CREATE TABLE "CommentTopic" (
  "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL REFERENCES "Article"(id) ON DELETE CASCADE,
  PRIMARY KEY ("entityId", "entityType")
);
CREATE TABLE "CommentV3" (
  "id" INTEGER PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL, "deletedAt" TIMESTAMP(3),
  FOREIGN KEY ("entityId", "entityType") REFERENCES "CommentTopic" ON DELETE CASCADE
);
`;

const HELD = 7;
const UNHELD = 8;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "EvidenceHeldUser" VALUES (${HELD});
    INSERT INTO "Article" VALUES (50, NULL, 1);
    INSERT INTO "CommentTopic" VALUES ('article', 50);
    INSERT INTO "Thread" (id, "articleId") VALUES (300, 50);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const rows = async (query: string) => (await db.query(query)).rows;
const deleteArticle = () => moderateArticle({ action: 'delete', articleId: 50, userId: 1 });

describe("a moderator's article delete", () => {
  it('deletes the article with its comments when no author is held', async () => {
    await db.exec(`
      INSERT INTO "CommentV2" VALUES (1, ${UNHELD}, 300);
      INSERT INTO "CommentV3" VALUES (1, 'article', 50, ${UNHELD}, NULL), (2, 'article', 50, ${UNHELD}, NULL);
    `);

    expect(await deleteArticle()).toEqual({ ok: true });

    expect(await rows(`SELECT id FROM "Article"`)).toEqual([]);
    expect(await rows(`SELECT id FROM "Thread"`)).toEqual([]);
    expect(await rows(`SELECT id FROM "CommentV2"`)).toEqual([]);
    expect(await rows(`SELECT id FROM "CommentV3"`)).toEqual([]);
  });

  it('deletes a held author’s comments with it too, in both tables', async () => {
    await db.exec(`
      INSERT INTO "CommentV2" VALUES (1, ${UNHELD}, 300);
      INSERT INTO "Thread" (id, "parentThreadId", "rootThreadId", "commentId") VALUES (301, 300, 300, 1);
      INSERT INTO "CommentV2" VALUES (2, ${HELD}, 301);
      INSERT INTO "CommentV3" VALUES (1, 'article', 50, ${UNHELD}, NULL), (5, 'article', 50, ${HELD}, NULL);
    `);

    expect(await deleteArticle()).toEqual({ ok: true });

    expect(await rows(`SELECT id FROM "Article"`)).toEqual([]);
    expect(await rows(`SELECT id FROM "Thread"`)).toEqual([]);
    expect(await rows(`SELECT id FROM "CommentV2"`)).toEqual([]);
    expect(await rows(`SELECT id FROM "CommentV3"`)).toEqual([]);
  });
});
