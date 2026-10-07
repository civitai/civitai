import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The main app caches a video's custom thumbnail under the VIDEO's id, so every moderator write that
 * changes a thumbnail's rating has to evict the parent's entry — the thumbnail's own id is not a key
 * that entry is ever stored under.
 */

const { dbHandle, del, syncSearchIndexBulk } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  del: vi.fn(async (_keys: string[]) => 0),
  syncSearchIndexBulk: vi.fn(async (_batch: { entityIds: number[]; action?: string }) => undefined),
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
vi.mock('../redis', () => ({
  getRedis: () => ({ del }),
  getSysRedis: () => ({ packed: { set: vi.fn(async () => undefined) } }),
}));
vi.mock('../image-moderation-effects', () => ({
  applyBlockSideEffects: vi.fn(async () => undefined),
  applyAcceptSideEffects: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
  refundAppealFee: vi.fn(async () => undefined),
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
  bustPostGalleryCaches: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn(), syncSearchIndexBulk }));
vi.mock('../kono', () => ({ syncKonoFinalize: vi.fn(async () => undefined) }));
vi.mock('../storage', () => ({
  getStorage: () => ({ deleteObject: vi.fn(async () => undefined) }),
}));

const { invalidateThumbnails } = await import('../thumbnail-cache');
const { acceptImage, blockImage } = await import('../image-moderation.service');
const { updateImageNsfwLevel } = await import('../image-nsfw-level');
const { deleteImagesByIds } = await import('../image-deletion');

const SCHEMA = `
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT,
  "type" TEXT,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT,
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "userId" INTEGER,
  "scannedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE "CollectionItem" ("imageId" INTEGER);
CREATE TABLE "Appeal" ("id" SERIAL, "entityType" TEXT, "entityId" INTEGER, "status" TEXT);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "Model3D" (
  "id" INTEGER PRIMARY KEY,
  "thumbnailImageId" INTEGER,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "lockedProperties" TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE "Model3DMetric" ("model3dId" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 0);
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
`;

const VIDEO_ID = 500;
const THUMBNAIL_ID = 501;
const OTHER_VIDEO_ID = 600;
const OTHER_THUMBNAIL_ID = 601;
const PLAIN_IMAGE_ID = 700;

const key = (id: number) => `${REDIS_KEYS.CACHES.THUMBNAILS}:${id}`;
const bustedKeys = () => del.mock.calls.flatMap(([keys]) => keys);
const reindexed = () =>
  syncSearchIndexBulk.mock.calls
    .filter(([batch]) => batch.action === 'update')
    .flatMap(([batch]) => batch.entityIds);

let db: PGlite;

beforeEach(async () => {
  del.mockClear();
  syncSearchIndexBulk.mockClear();
  db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.query(
    `INSERT INTO "Image" ("id", "type", "metadata", "nsfwLevel") VALUES
      ($1, 'video', jsonb_build_object('thumbnailId', $2::int), 1),
      ($2, 'image', jsonb_build_object('parentId', $1::int), 1),
      ($3, 'video', jsonb_build_object('thumbnailId', $4::int), 1),
      ($4, 'image', jsonb_build_object('parentId', $3::int), 1),
      ($5, 'image', NULL, 1)`,
    [VIDEO_ID, THUMBNAIL_ID, OTHER_VIDEO_ID, OTHER_THUMBNAIL_ID, PLAIN_IMAGE_ID]
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('invalidateThumbnails', () => {
  it("evicts each thumbnail's parent video entry, resolved in one batch", async () => {
    await invalidateThumbnails([THUMBNAIL_ID, OTHER_THUMBNAIL_ID, PLAIN_IMAGE_ID]);

    expect(new Set(bustedKeys())).toEqual(
      new Set([
        key(THUMBNAIL_ID),
        key(OTHER_THUMBNAIL_ID),
        key(PLAIN_IMAGE_ID),
        key(VIDEO_ID),
        key(OTHER_VIDEO_ID),
      ])
    );
    expect(reindexed().sort()).toEqual([VIDEO_ID, OTHER_VIDEO_ID]);
  });

  it('re-indexes the parent only after its cache entry is gone', async () => {
    await invalidateThumbnails(THUMBNAIL_ID);

    expect(del.mock.invocationCallOrder[0]).toBeLessThan(
      syncSearchIndexBulk.mock.invocationCallOrder[0]
    );
  });

  it('leaves a video that is itself being moderated to its caller to re-index', async () => {
    await invalidateThumbnails([VIDEO_ID, THUMBNAIL_ID]);

    expect(reindexed()).toEqual([]);
  });

  it('logs instead of failing the committed write when Redis is down', async () => {
    del.mockRejectedValueOnce(new Error('redis down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(invalidateThumbnails(THUMBNAIL_ID)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('ignores a malformed parentId instead of failing', async () => {
    await db.query(`UPDATE "Image" SET "metadata" = '{"parentId": "abc"}' WHERE "id" = $1`, [
      PLAIN_IMAGE_ID,
    ]);

    await blockImage({ imageId: PLAIN_IMAGE_ID, userId: 1 });

    expect(bustedKeys()).toEqual([key(PLAIN_IMAGE_ID)]);
  });

  it('uses the parent ids it is handed instead of asking the database', async () => {
    await db.query(`DELETE FROM "Image" WHERE "id" = $1`, [THUMBNAIL_ID]);

    await invalidateThumbnails([THUMBNAIL_ID], [VIDEO_ID]);

    expect(bustedKeys()).toContain(key(VIDEO_ID));
    expect(reindexed()).toEqual([VIDEO_ID]);
  });
});

describe('moderator writes that change a custom thumbnail', () => {
  it('blockImage evicts the parent video entry', async () => {
    await blockImage({ imageId: THUMBNAIL_ID, userId: 1 });

    expect(bustedKeys()).toContain(key(VIDEO_ID));
    expect(reindexed()).toEqual([VIDEO_ID]);
  });

  it('updateImageNsfwLevel evicts the parent video entry', async () => {
    await updateImageNsfwLevel({ id: THUMBNAIL_ID, nsfwLevel: 16, userId: 1 });

    expect(bustedKeys()).toContain(key(VIDEO_ID));
    expect(reindexed()).toEqual([VIDEO_ID]);
  });

  it('acceptImage evicts the parent video entry', async () => {
    await acceptImage({ imageId: THUMBNAIL_ID, userId: 1 });

    expect(bustedKeys()).toContain(key(VIDEO_ID));
    expect(reindexed()).toEqual([VIDEO_ID]);
  });

  it('deleteImagesByIds evicts the parent video entry after the row is gone', async () => {
    await deleteImagesByIds([THUMBNAIL_ID, OTHER_THUMBNAIL_ID]);

    expect(bustedKeys()).toEqual(expect.arrayContaining([key(VIDEO_ID), key(OTHER_VIDEO_ID)]));
    expect(reindexed().sort()).toEqual([VIDEO_ID, OTHER_VIDEO_ID]);
  });
});
