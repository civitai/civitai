import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Axiom from '../axiom';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A moderator's song delete deletes the song's cover, which the `Track` cascade would otherwise leave
 * unlinked. A hold on the cover keeps it as it would any image. The rule: docs/features/music.md,
 * "A generated song's cover" (cover cleanup).
 */

const MODERATOR = { id: 1, isModerator: true };
const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('../redis', () => ({
  getRedis: () => ({ del: vi.fn(async () => 0) }),
  getSysRedis: () => ({ packed: { set: vi.fn(async () => undefined) } }),
}));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn(), syncSearchIndexBulk: vi.fn() }));
vi.mock('../image-moderation-effects', () => ({
  bustPostGalleryCaches: vi.fn(),
  queueComicsForImages: vi.fn(async () => undefined),
}));
vi.mock('../home-blocks', () => ({ evictHomeBlocks: vi.fn(async () => undefined) }));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ insert: vi.fn(async () => undefined) }),
}));
vi.mock('../axiom', async (importOriginal) => ({
  ...(await importOriginal<typeof Axiom>()),
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: vi.fn(async () => undefined),
}));

const { deleteImages } = await import('../image-deletion');
const { syncSearchIndexBulk } = await import('../search-index');

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "profilePictureId" INTEGER, "image" TEXT);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT,
  "userId" INTEGER NOT NULL,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "metadata" JSONB,
  "postId" INTEGER,
  "updatedAt" TIMESTAMP(3)
);
CREATE TABLE "Track" (
  "imageId" INTEGER PRIMARY KEY REFERENCES "Image"(id) ON DELETE CASCADE,
  "coverImageId" INTEGER REFERENCES "Image"(id) ON DELETE SET NULL
);
CREATE TABLE "CollectionItem" ("imageId" INTEGER);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER,
  "details" JSONB NOT NULL DEFAULT '{}',
  "images" JSONB NOT NULL DEFAULT '[]',
  "reportSentAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER);
CREATE TABLE "EvidenceHoldImage" ("imageId" INTEGER, "postId" INTEGER);
CREATE TABLE "Article" ("id" INTEGER PRIMARY KEY, "coverId" INTEGER, "userId" INTEGER, "bannerId" INTEGER);
CREATE TABLE "File" ("entityId" INTEGER, "entityType" TEXT);
CREATE TABLE "ImageConnection" ("imageId" INTEGER, "entityId" INTEGER, "entityType" TEXT);
CREATE TABLE "CommentTopic" ("entityType" TEXT, "entityId" INTEGER);
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
CREATE TYPE "JobQueueType" AS ENUM ('PendingDelete', 'ImageStorageDelete', 'CdnAccessSync', 'UpdateNsfwLevel', 'ImageDelete', 'BlockedImageDelete');
CREATE TABLE "JobQueue" (
  "entityId" INTEGER, "entityType" "EntityType", "type" "JobQueueType", "data" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("entityType", "entityId", "type")
);
`;

const OWNER = 10;
const SONG = 1;
const COVER = 2;

let db: PGlite;

beforeEach(async () => {
  vi.mocked(syncSearchIndexBulk).mockClear();
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(imageUseTablesSql);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  await db.exec(`
    INSERT INTO "Image" (id, url, "userId", metadata) VALUES
      (${SONG}, 'key-song', ${OWNER}, NULL),
      (${COVER}, 'key-cover', ${OWNER}, '{"parentId": ${SONG}}');
    INSERT INTO "Track" ("imageId", "coverImageId") VALUES (${SONG}, ${COVER});
  `);
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const remaining = async () =>
  (await db.query<{ id: number }>(`SELECT id FROM "Image" ORDER BY id`)).rows.map((r) => r.id);
const queuedUrls = async () =>
  (
    await db.query<{ url: string }>(
      `SELECT data->>'url' AS url FROM "JobQueue" WHERE type = 'ImageStorageDelete' ORDER BY url`
    )
  ).rows.map((r) => r.url);
const deindexed = () =>
  vi
    .mocked(syncSearchIndexBulk)
    .mock.calls.flatMap(([batch]) => (batch.action === 'delete' ? batch.entityIds : []))
    .sort((a, b) => a - b);
/** An open CSAM report on the image: a child-safety case the delete waits on. */
const openCsamReport = (imageId: number) =>
  db.exec(`
    INSERT INTO "Report" (id, reason, status) VALUES (1, 'CSAM', 'Pending');
    INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${imageId}, 1);
  `);

describe('a moderator deleting a song', () => {
  it('deletes its cover, its stored file and its search entry', async () => {
    const refused = await deleteImages([SONG], MODERATOR);
    expect(await remaining()).toEqual([]);
    expect(await queuedUrls()).toEqual(['key-cover', 'key-song']);
    expect(deindexed()).toEqual([SONG, COVER]);
    expect(refused).toEqual([]);
  });

  it('keeps a cover in a child-safety case, blocked', async () => {
    await openCsamReport(COVER);
    const refused = await deleteImages([SONG], MODERATOR);
    expect(await remaining()).toEqual([COVER]);
    const { rows } = await db.query(`SELECT ingestion, "nsfwLevel" FROM "Image" WHERE id = $1`, [
      COVER,
    ]);
    expect(rows).toEqual([{ ingestion: 'Blocked', nsfwLevel: 32 }]);
    expect(await queuedUrls()).toEqual(['key-song']);
    expect(refused).toEqual([{ id: COVER, reason: 'review' }]);
  });

  it('keeps a cover a CSAM report lists, and says so', async () => {
    await db.exec(
      `INSERT INTO "CsamReport" ("userId", images, "reportSentAt", "archivedAt")
       VALUES (99, '[{"id": ${COVER}}]', now() - interval '400 days', now() - interval '390 days')`
    );
    const refused = await deleteImages([SONG], MODERATOR);
    expect(await remaining()).toEqual([COVER]);
    expect(refused).toEqual([{ id: COVER, reason: 'review' }]);
  });

  it('leaves the cover of a song its hold keeps', async () => {
    await openCsamReport(SONG);
    await deleteImages([SONG], MODERATOR);
    expect(await remaining()).toEqual([SONG, COVER]);
    const { rows } = await db.query(`SELECT ingestion FROM "Image" WHERE id = $1`, [COVER]);
    expect(rows).toEqual([{ ingestion: null }]);
  });

  it("leaves another song's linked image that names this song as its parent", async () => {
    await db.exec(`
      INSERT INTO "Image" (id, url, "userId", metadata) VALUES
        (6, 'key-6', ${OWNER}, NULL), (3, 'key-3', ${OWNER}, '{"parentId": ${SONG}}');
      INSERT INTO "Track" ("imageId", "coverImageId") VALUES (6, 3);
    `);
    await deleteImages([6], MODERATOR);
    expect(await remaining()).toEqual([SONG, COVER, 3]);
  });

  it('leaves a linked image that is in a post', async () => {
    await db.exec(`UPDATE "Image" SET "postId" = 70 WHERE id = ${COVER}`);
    await deleteImages([SONG], MODERATOR);
    expect(await remaining()).toEqual([COVER]);
  });

  it('deletes a song listed with its own cover once', async () => {
    const refused = await deleteImages([SONG, COVER], MODERATOR);
    expect(await remaining()).toEqual([]);
    expect(await queuedUrls()).toEqual(['key-cover', 'key-song']);
    expect(deindexed()).toEqual([SONG, COVER]);
    expect(refused).toEqual([]);
  });

  it('refuses a held cover listed with its song once', async () => {
    await openCsamReport(COVER);
    const refused = await deleteImages([SONG, COVER], MODERATOR);
    expect(await remaining()).toEqual([COVER]);
    expect(refused).toEqual([{ id: COVER, reason: 'review' }]);
  });

  it('leaves a linked image that was not made for the song', async () => {
    await db.exec(`UPDATE "Image" SET metadata = NULL WHERE id = ${COVER}`);
    await deleteImages([SONG], MODERATOR);
    expect(await remaining()).toEqual([COVER]);
  });
});

it('a moderator deleting an image leaves an image naming it as its parent', async () => {
  await db.exec(`
    INSERT INTO "Image" (id, url, "userId", metadata) VALUES
      (4, 'key-4', ${OWNER}, NULL), (5, 'key-5', ${OWNER}, '{"parentId": 4}');
  `);
  await deleteImages([4], MODERATOR);
  expect(await remaining()).toEqual([SONG, COVER, 5]);
});
