import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Axiom from '../axiom';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** A moderator delete keeps an image in an open child-safety case, and deletes the rest. */

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

const { deleteImages: deleteModeratorImages } = await import('../image-deletion');
const { syncSearchIndexBulk } = await import('../search-index');
const { dropBlockedImageDeleteQueue } = await import('../blocked-image-queue');

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
CREATE TABLE "CollectionItem" ("imageId" INTEGER);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER,
  "details" JSONB NOT NULL DEFAULT '{}',
  "images" JSONB NOT NULL DEFAULT '[]',
  "reportSentAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3)
);
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
const OTHER_OWNER = 11;
const PLAIN = 1;

let db: PGlite;

beforeEach(async () => {
  vi.mocked(syncSearchIndexBulk).mockClear();
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(imageUseTablesSql);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const image = (
  id: number,
  { userId = OWNER, needsReview = null as string | null, blockedFor = null as string | null } = {}
) =>
  db.query(
    `INSERT INTO "Image" (id, url, "userId", "needsReview", "blockedFor") VALUES ($1, $2, $3, $4, $5)`,
    [id, `key-${id}`, userId, needsReview, blockedFor]
  );

const report = (fields: {
  userId?: number | null;
  images?: unknown[];
  details?: Record<string, unknown>;
  sentDaysAgo?: number | null;
  archivedDaysAgo?: number | null;
}) =>
  db.query(
    `INSERT INTO "CsamReport" ("userId", images, details, "reportSentAt", "archivedAt") VALUES (
      $1, $2::jsonb, $3::jsonb,
      CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END,
      CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END
    )`,
    [
      fields.userId ?? null,
      JSON.stringify(fields.images ?? []),
      JSON.stringify(fields.details ?? {}),
      fields.sentDaysAgo ?? null,
      fields.archivedDaysAgo ?? null,
    ]
  );

const remaining = async () =>
  (await db.query<{ id: number }>(`SELECT id FROM "Image" ORDER BY id`)).rows.map((r) => r.id);
/** The stored files the delete queued for the main app's `image-storage-deletes` job. */
const queuedFiles = async () =>
  (
    await db.query<{ entityId: number; data: { url: string; allVersions?: boolean } }>(
      `SELECT "entityId", data FROM "JobQueue" WHERE type = 'ImageStorageDelete' ORDER BY "entityId"`
    )
  ).rows;
const queuedUrls = async () => (await queuedFiles()).map((r) => r.data.url);
/** The moderator CDN takedowns the DELETE queued for `cdn-access-sync`. */
const cdnQueued = async () =>
  (
    await db.query<{ entityId: number }>(
      `SELECT "entityId" FROM "JobQueue" WHERE type = 'CdnAccessSync' AND data->>'moderatorDelete' = 'true' ORDER BY "entityId"`
    )
  ).rows.map((r) => r.entityId);

/** A moderator's delete; resolves to the images a child-safety case kept. */
const deleteImages = (ids: number[]) => deleteModeratorImages(ids, MODERATOR);
/** The ids sent to search for removal, sorted: the post-commit finish's first act. */
const deindexed = () =>
  vi
    .mocked(syncSearchIndexBulk)
    .mock.calls.flatMap(([batch]) => (batch.action === 'delete' ? batch.entityIds : []))
    .sort((a, b) => a - b);

const imageRow = async (id: number) =>
  (await db.query(`SELECT * FROM "Image" WHERE id = $1`, [id])).rows[0];
const collectionItems = async () =>
  (
    await db.query<{ imageId: number }>(`SELECT "imageId" FROM "CollectionItem" ORDER BY 1`)
  ).rows.map((r) => r.imageId);
const pendingDeletes = async () =>
  (
    await db.query<{ entityId: number; data: unknown }>(
      `SELECT "entityId", data - 'prior' AS data FROM "JobQueue" WHERE type = 'PendingDelete' ORDER BY "entityId"`
    )
  ).rows;

/**
 * Deletes `id` beside the plain control, and asserts `id` alone was kept as the moderator's pending
 * delete: blocked, out of search, its file and collection entries untouched.
 */
const expectKept = async (id: number) => {
  await db.query(`INSERT INTO "CollectionItem" VALUES ($1), ($2)`, [PLAIN, id]);
  const refused = await deleteImages([PLAIN, id]);
  expect(await remaining()).toEqual([id]);
  expect(await imageRow(id)).toMatchObject({ ingestion: 'Blocked', nsfwLevel: 32 });
  expect(await collectionItems()).toEqual([id]);
  expect(await queuedUrls()).toEqual([`key-${PLAIN}`]);
  expect(await cdnQueued()).toEqual([PLAIN]);
  expect(deindexed()).toEqual([PLAIN, id]);
  expect(await pendingDeletes()).toEqual([
    { entityId: id, data: { deletedBy: 'moderator:1', moderatorDelete: true } },
  ]);
  expect(refused).toEqual([{ id, reason: 'review' }]);
};

describe('deleteImages', () => {
  beforeEach(() => image(PLAIN, { userId: OTHER_OWNER }));

  it('deletes an image in no case, purging every version of its stored file, and takes it out of search', async () => {
    await image(2, { blockedFor: 'moderated' });
    const refused = await deleteImages([PLAIN, 2]);
    expect(await remaining()).toEqual([]);
    expect(await queuedFiles()).toEqual([
      { entityId: PLAIN, data: { url: `key-${PLAIN}`, allVersions: true } },
      { entityId: 2, data: { url: 'key-2', allVersions: true } },
    ]);
    expect(deindexed()).toEqual([PLAIN, 2]);
    expect(refused).toEqual([]);
  });

  it('keeps the row, and finishes nothing, when its stored file cannot be queued', async () => {
    await image(2);
    await db.exec(`DROP TABLE "JobQueue"`);
    await expect(deleteImages([2])).rejects.toThrow();
    // The takedown would have gone in the same statement, to the table that is gone.
    expect(await remaining()).toEqual([PLAIN, 2]);
    expect(deindexed()).toEqual([]);
  });

  it('keeps an image flagged for CSAM review', async () => {
    await image(2, { needsReview: 'csam' });
    await expectKept(2);
  });

  it('keeps an image blocked for CSAM', async () => {
    await image(2, { blockedFor: 'CSAM' });
    await expectKept(2);
  });

  // The trigger flags image 2 on the first image's CollectionItem delete, after the batch began and
  // before image 2's own delete, which reads the flag as it is then.
  it('keeps an image flagged for CSAM review partway through the batch', async () => {
    await image(2);
    await db.exec(`
      CREATE FUNCTION flag_late() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 2; RETURN OLD; END $$;
      CREATE TRIGGER flag_late BEFORE DELETE ON "CollectionItem"
        FOR EACH ROW EXECUTE FUNCTION flag_late();
      INSERT INTO "CollectionItem" VALUES (${PLAIN});
    `);
    const refused = await deleteImages([PLAIN, 2]);
    expect(await remaining()).toEqual([2]);
    expect(refused).toEqual([{ id: 2, reason: 'review' }]);
    expect(await pendingDeletes()).toEqual([
      { entityId: 2, data: { deletedBy: 'moderator:1', moderatorDelete: true } },
    ]);
  });

  // No account-wide hold: only the image's own case keeps it.
  it('deletes an unflagged image whose owner is named on an unsent report, or has another flagged image', async () => {
    await image(2);
    await image(3, { needsReview: 'csam' });
    await report({ userId: OWNER });
    const refused = await deleteImages([PLAIN, 2]);
    expect(await remaining()).toEqual([3]);
    expect(refused).toEqual([]);
  });

  it('deletes an image owned by the placeholder owner', async () => {
    await image(2, { userId: -1 });
    await deleteImages([2]);
    expect(await remaining()).toEqual([PLAIN]);
  });

  // An unblock or an approved appeal reverses the moderator's delete (docs/features/pending-deletes.md).
  it("drops the moderator's pending delete when the block is lifted", async () => {
    await image(2, { needsReview: 'csam' });
    await deleteImages([2]);
    expect(await pendingDeletes()).toHaveLength(1);

    await dropBlockedImageDeleteQueue(2);

    expect(await pendingDeletes()).toEqual([]);
  });
});
