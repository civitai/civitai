import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  SET_ASIDE_TABLE_SQL,
} from '../../../test/held-image-tables';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The main app caches each user's profile picture for a day, and avatars are shown or hidden on that
 * cached rating. A moderator block, re-rate or delete of an image that is someone's profile picture
 * has to evict that user's entry, and must not fail the action when the eviction fails.
 */

const { dbHandle, del, hSet, syncSearchIndexBulk } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  del: vi.fn(async (_keys: string[]) => 0),
  hSet: vi.fn(async (_key: string, _value: Record<string, string>) => 1),
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
  getRedis: () => ({ del, hSet, expire: async () => true }),
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
  trackImageRestore: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn(), syncSearchIndexBulk }));
vi.mock('../kono', () => ({ syncKonoFinalize: vi.fn(async () => undefined) }));
vi.mock('../storage', () => ({
  getStorage: () => ({
    deleteObject: vi.fn(async () => undefined),
    purgeObjectVersions: vi.fn(async () => ({ versionsDeleted: 1, remaining: 0 })),
  }),
}));

const { blockImage, acceptImage } = await import('../image-moderation.service');
const { updateImageNsfwLevel } = await import('../image-nsfw-level');
const { deleteImageRows, finishImageDeletes } = await import('../image-deletion');
const { bustProfilePictures } = await import('../profile-picture-cache');
const deleteImages = async (ids: number[]) =>
  finishImageDeletes(
    await (dbHandle.current as Kysely<DB>).transaction().execute((trx) => deleteImageRows(trx, ids))
  );

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
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER);
CREATE TABLE "Appeal" ("id" SERIAL, "entityType" TEXT, "entityId" INTEGER, "status" TEXT);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER,
  PRIMARY KEY ("entityType", "entityId", "type"));
CREATE TABLE "Model3D" (
  "id" INTEGER PRIMARY KEY,
  "thumbnailImageId" INTEGER,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "lockedProperties" TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE "Model3DMetric" ("model3dId" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 0);
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY,
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
  hSet.mockClear();
  syncSearchIndexBulk.mockClear();
  db = await freshPglite();
  await db.exec(SCHEMA);
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
    // The event engine's copy too.
    expect(hSet).toHaveBeenCalledWith(`user:profilePicture:v3:${AVATAR_OWNER}`, {
      debounce: '1',
      cachedAt: expect.any(String),
    });
  });

  it('blockImage clears a User.image naming the blocked picture, marks it, and evicts the basic user', async () => {
    await blockImage({ imageId: AVATAR_ID, userId: 1 });

    expect(await ownerRow()).toEqual({
      image: null,
      meta: { heldImageCleared: { pictureId: AVATAR_ID } },
    });
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

  it('acceptImage after a block puts User.image back from the picture', async () => {
    await blockImage({ imageId: AVATAR_ID, userId: 1 });
    await acceptImage({ imageId: AVATAR_ID, userId: 1 });

    expect(await ownerRow()).toEqual({ image: 'avatar-key', meta: {} });
  });

  it('a partly lifted block keeps User.image empty and the marker in place', async () => {
    await blockImage({ imageId: AVATAR_ID, userId: 1 });
    await db.query(
      `UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 1, "blockedFor" = 'tos' WHERE id = $1`,
      [AVATAR_ID]
    );
    await bustProfilePictures({ imageIds: [AVATAR_ID] });

    expect(await ownerRow()).toEqual({
      image: null,
      meta: { heldImageCleared: { pictureId: AVATAR_ID } },
    });
  });

  it('never restores a picture under a csam or minor hold', async () => {
    for (const review of ['csam', 'minor']) {
      await db.query(
        `UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 1, "blockedFor" = NULL, "needsReview" = $2 WHERE id = $1`,
        [AVATAR_ID, review]
      );
      await db.query(`UPDATE "User" SET image = NULL, meta = $2 WHERE id = $1`, [
        AVATAR_OWNER,
        JSON.stringify({ heldImageCleared: { pictureId: AVATAR_ID } }),
      ]);
      await bustProfilePictures({ imageIds: [AVATAR_ID] });

      expect(await ownerRow()).toEqual({
        image: null,
        meta: { heldImageCleared: { pictureId: AVATAR_ID } },
      });
    }
  });

  it("restores nothing for a write to an image that is not the user's picture", async () => {
    await db.query(
      `UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 1 WHERE id IN ($1, $2)`,
      [AVATAR_ID, OTHER_IMAGE_ID]
    );
    await db.query(`UPDATE "User" SET image = NULL, meta = $2 WHERE id = $1`, [
      AVATAR_OWNER,
      JSON.stringify({ heldImageCleared: { pictureId: AVATAR_ID } }),
    ]);
    await blockImage({ imageId: OTHER_IMAGE_ID, userId: 1 });

    expect((await ownerRow()).image).toBeNull();
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
