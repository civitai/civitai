import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  SET_ASIDE_TABLE_SQL,
} from '../../../test/held-image-tables';
import { Kysely } from 'kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The main app caches each user's profile picture for a day, and avatars are shown or hidden on that
 * cached rating. A moderator block, re-rate or delete of an image that is someone's profile picture
 * has to evict that user's entry, and must not fail the action when the eviction fails.
 */

const MODERATOR = { id: 1, isModerator: true };
const { dbHandle, del, syncSearchIndexBulk } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  del: vi.fn(async (_keys: string[]) => 0),
  syncSearchIndexBulk: vi.fn(async (_batch: { entityIds: number[]; action?: string }) => undefined),
}));

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
  queueComicsForImages: vi.fn(async () => undefined),
  trackImageRestore: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({
  insertModActivity: vi.fn(async () => 1),
  recordModActivity: vi.fn(async () => undefined),
}));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn(), syncSearchIndexBulk }));

const { blockImage, acceptImage } = await import('../image-moderation.service');
const { updateImageNsfwLevel } = await import('../image-nsfw-level');
const { deleteImages: deleteModeratorImages } = await import('../image-deletion');
const { bustProfilePictures } = await import('../profile-picture-cache');
const deleteImages = (ids: number[]) => deleteModeratorImages(ids, MODERATOR);

const SCHEMA = `
CREATE DOMAIN "ImageIngestionStatus" AS TEXT;
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
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE,
  "scanJobs" JSONB,
  "modelRestricted" BOOLEAN NOT NULL DEFAULT FALSE
);
${SET_ASIDE_TABLE_SQL}
${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
CREATE TABLE "CollectionItem" ("imageId" INTEGER);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "details" JSONB NOT NULL DEFAULT '{}',
  "images" JSONB NOT NULL DEFAULT '[]', "reportSentAt" TIMESTAMP(3), "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "Appeal" ("id" SERIAL, "entityType" TEXT, "entityId" INTEGER, "status" TEXT);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
CREATE TYPE "JobQueueType" AS ENUM (
  'PendingDelete', 'BlockedImageDelete', 'ImageScan', 'ImageStorageDelete', 'UpdateNsfwLevel', 'CdnAccessSync', 'ImageDelete'
);
CREATE TABLE "JobQueue" ("type" "JobQueueType", "entityType" "EntityType", "entityId" INTEGER,
  "data" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("entityType", "entityId", "type"));
CREATE TABLE "Model3D" (
  "id" INTEGER PRIMARY KEY,
  "thumbnailImageId" INTEGER,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "lockedProperties" TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE "Model3DMetric" ("model3dId" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 0);
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY, "deletedAt" TIMESTAMP(3),
  "profilePictureId" INTEGER REFERENCES "Image"(id) ON DELETE SET NULL,
  "image" TEXT,
  "meta" JSONB
);
-- The rating recompute, standing in for one that rates an unblocked image from its tags.
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$
  UPDATE "Image" SET "nsfwLevel" = 1
  WHERE id = ANY(ids) AND "ingestion" IS DISTINCT FROM 'Blocked' AND "blockedFor" IS NULL
$$;
CREATE TABLE "TagsOnImageDetails" ("imageId" INTEGER, "tagId" INTEGER, "disabled" BOOLEAN);
CREATE TABLE "ImageRatingRequest" (
  "imageId" INTEGER NOT NULL, "userId" INTEGER NOT NULL, "nsfwLevel" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending', PRIMARY KEY ("imageId", "userId")
);
CREATE FUNCTION queue_cdn_access_sync(entity_id INTEGER, entity_type TEXT, payload JSONB)
  RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
`;

const AVATAR_ID = 800;
const OTHER_IMAGE_ID = 801;
const AVATAR_OWNER = 42;

const avatarKey = `${REDIS_KEYS.CACHES.PROFILE_PICTURES}:${AVATAR_OWNER}`;
const bustedKeys = () => del.mock.calls.flatMap(([keys]) => keys);

let db: PGlite;
const ownerRow = async () =>
  (
    await db.query<{ image: string | null; meta: unknown }>(
      `SELECT "image", "meta" FROM "User" WHERE "id" = $1`,
      [AVATAR_OWNER]
    )
  ).rows[0];

beforeEach(async () => {
  del.mockReset();
  del.mockImplementation(async () => 0);
  syncSearchIndexBulk.mockClear();
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(imageUseTablesSql);
  await db.query(
    `INSERT INTO "Image" ("id", "url", "type", "userId", "nsfwLevel") VALUES
      ($1, 'avatar-key', 'image', $3, 1), ($2, 'other-key', 'image', $3, 1)`,
    [AVATAR_ID, OTHER_IMAGE_ID, AVATAR_OWNER]
  );
  await db.query(
    `INSERT INTO "User" ("id", "profilePictureId", "image", "meta") VALUES ($1, $2, $3, '{}')`,
    [AVATAR_OWNER, AVATAR_ID, 'https://cdn.example/avatar-key/width=96']
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('moderator writes to an image that is a profile picture', () => {
  it("blockImage evicts the avatar owner's cached profile picture", async () => {
    await blockImage({ imageId: AVATAR_ID, userId: 1 });

    expect(bustedKeys()).toContain(avatarKey);
  });

  it('blockImage clears a User.image naming the blocked picture and evicts the basic user', async () => {
    await blockImage({ imageId: AVATAR_ID, userId: 1 });

    expect(await ownerRow()).toEqual({ image: null, meta: {} });
    expect(bustedKeys()).toContain(`${REDIS_KEYS.CACHES.BASIC_USERS}:${AVATAR_OWNER}`);
    expect(del.mock.calls.flat()).toContain(`${REDIS_KEYS.USER.SESSION}:${AVATAR_OWNER}`);
    expect(syncSearchIndexBulk).toHaveBeenCalledWith({
      entityType: 'user',
      entityIds: [AVATAR_OWNER],
      action: 'update',
    });
  });

  it("blockImage on an image that is not the user's picture leaves User.image alone", async () => {
    await blockImage({ imageId: OTHER_IMAGE_ID, userId: 1 });

    expect(await ownerRow()).toEqual({
      image: 'https://cdn.example/avatar-key/width=96',
      meta: {},
    });
  });

  it('🔴 acceptImage after a block leaves User.image empty: the picture serves the avatar', async () => {
    await blockImage({ imageId: AVATAR_ID, userId: 1 });
    del.mockClear();
    await acceptImage({ imageId: AVATAR_ID, userId: 1 });

    expect(await ownerRow()).toEqual({ image: null, meta: {} });
    // The accept itself evicts the picture's cache entry, so the accepted picture is read afresh.
    expect(bustedKeys()).toContain(avatarKey);
  });

  it('updateImageNsfwLevel evicts it', async () => {
    await updateImageNsfwLevel({ id: AVATAR_ID, nsfwLevel: 16, userId: 1 });

    expect(bustedKeys()).toContain(avatarKey);
  });

  it('an image delete evicts it, though the row naming the avatar is gone', async () => {
    await deleteImages([AVATAR_ID]);

    expect(bustedKeys()).toContain(avatarKey);
  });

  it('acceptImage evicts it: the accept recomputes the rating from tags', async () => {
    await acceptImage({ imageId: AVATAR_ID, userId: 1 });

    expect(bustedKeys()).toContain(avatarKey);
  });

  it('records the new rating on an image under an account-deletion grace block', async () => {
    await db.query(
      `UPDATE "Image" SET "metadata" = '{"accountDeletionPriorIngestion": "Scanned", "accountDeletionPriorNsfwLevel": 1, "accountDeletionPriorNsfwLevelLocked": false}' WHERE "id" = $1`,
      [OTHER_IMAGE_ID]
    );

    await updateImageNsfwLevel({ id: OTHER_IMAGE_ID, nsfwLevel: 32, userId: 1 });
    await updateImageNsfwLevel({ id: AVATAR_ID, nsfwLevel: 16, userId: 1 });

    const { rows } = await db.query<{ id: number; metadata: Record<string, unknown> | null }>(
      `SELECT "id", "metadata" FROM "Image" WHERE "id" IN ($1, $2)`,
      [OTHER_IMAGE_ID, AVATAR_ID]
    );
    const byId = new Map(rows.map((row) => [row.id, row.metadata ?? {}]));
    expect(byId.get(OTHER_IMAGE_ID)).toMatchObject({
      accountDeletionPriorNsfwLevel: 32,
      accountDeletionPriorNsfwLevelLocked: true,
    });
    // Control: an image with no grace block gets no recorded rating.
    expect(byId.get(AVATAR_ID)).not.toHaveProperty('accountDeletionPriorNsfwLevel');
  });

  it("evicts nothing for an image that is nobody's avatar", async () => {
    await updateImageNsfwLevel({ id: OTHER_IMAGE_ID, nsfwLevel: 16, userId: 1 });

    expect(bustedKeys()).not.toContain(avatarKey);
  });

  it('still completes the re-rate when the eviction fails', async () => {
    del.mockRejectedValue(new Error('redis down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      updateImageNsfwLevel({ id: AVATAR_ID, nsfwLevel: 16, userId: 1 })
    ).resolves.toBeUndefined();
    const { rows } = await db.query<{ nsfwLevel: number }>(
      `SELECT "nsfwLevel" FROM "Image" WHERE "id" = $1`,
      [AVATAR_ID]
    );
    expect(rows[0].nsfwLevel).toBe(16);
  });
});

describe('a moderator block of an image a stale User.image names', () => {
  const OLD_KEY = '3f6e2a10-9b4c-4d7e-8a21-6c0b5d9e1f42';

  it("🔴 clears that User.image and evicts the owner's session", async () => {
    await db.query(`UPDATE "Image" SET "url" = $1 WHERE "id" = $2`, [OLD_KEY, OTHER_IMAGE_ID]);
    await db.query(`UPDATE "User" SET "image" = $1 WHERE "id" = $2`, [
      `https://cdn.example/${OLD_KEY}/width=96`,
      AVATAR_OWNER,
    ]);
    await blockImage({ imageId: OTHER_IMAGE_ID, userId: 1 });

    expect(await ownerRow()).toEqual({ image: null, meta: {} });
    expect(bustedKeys()).toContain(`${REDIS_KEYS.USER.SESSION}:${AVATAR_OWNER}`);
  });
});

describe('updateImageNsfwLevel rating requests', () => {
  const requests = async () =>
    (
      await db.query<{ imageId: number; userId: number; status: string }>(
        `SELECT "imageId", "userId", "status" FROM "ImageRatingRequest" ORDER BY "imageId", "userId"`
      )
    ).rows;

  beforeEach(async () => {
    await db.query(
      `INSERT INTO "ImageRatingRequest" ("imageId", "userId", "nsfwLevel", "status") VALUES
        ($1, 7, 4, 'Pending'), ($1, 8, 4, 'Unactioned'), ($2, 7, 4, 'Pending')`,
      [AVATAR_ID, OTHER_IMAGE_ID]
    );
  });

  // An Inquisitor ruling passes a status: left Pending, the requests return to the rating queue on unlock.
  it("settles only the image's Pending requests with the status given", async () => {
    await updateImageNsfwLevel({ id: AVATAR_ID, nsfwLevel: 4, status: 'Actioned', userId: 1 });

    expect(await requests()).toEqual([
      { imageId: AVATAR_ID, userId: 7, status: 'Actioned' },
      { imageId: AVATAR_ID, userId: 8, status: 'Unactioned' },
      { imageId: OTHER_IMAGE_ID, userId: 7, status: 'Pending' },
    ]);
  });

  it('leaves every request alone without a status', async () => {
    await updateImageNsfwLevel({ id: AVATAR_ID, nsfwLevel: 4, userId: 1 });

    expect((await requests()).map((r) => r.status)).toEqual(['Pending', 'Unactioned', 'Pending']);
  });
});
