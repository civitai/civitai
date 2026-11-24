import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A song is published only by its own scans. A moderator's rating locks the level, and a locked level
 * counts as reviewed, so the rating writer refuses a song its scans have not yet given their verdict
 * on (PR #10162), and rates one they have (Music T10, docs/features/music.md "Moderating songs"). A
 * picture's rating is covered in image-nsfw-level-models-reindex.test.ts.
 */

vi.setConfig({ hookTimeout: 60_000 });

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
vi.mock('../image-moderation-effects', () => ({
  bustPostGalleryCaches: vi.fn(async () => undefined),
}));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: vi.fn(async () => undefined) }));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../kono', () => ({ syncKonoFinalize: vi.fn(async () => undefined) }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../image-models-reindex', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
}));

const { SongRatingRefusedError, updateImageNsfwLevel } = await import('../image-nsfw-level');

const SCHEMA = `
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "type" TEXT NOT NULL,
  "postId" INTEGER,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE,
  "ingestion" TEXT NOT NULL DEFAULT 'Scanned'
);
CREATE TABLE "ImageRatingRequest" ("imageId" INTEGER, "status" TEXT);
`;

const SONG = 990000101;
const REVIEWED_SONG = 990000102;

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`TRUNCATE "Image";
    INSERT INTO "Image" ("id", "type", "ingestion") VALUES (${SONG}, 'audio', 'Pending');
    INSERT INTO "Image" ("id", "type", "ingestion", "postId") VALUES (${REVIEWED_SONG}, 'audio', 'Scanned', 7);`);
});

const row = async (id: number) =>
  (
    await db.query<{ nsfwLevel: number; nsfwLevelLocked: boolean; metadata: unknown }>(
      `SELECT "nsfwLevel", "nsfwLevelLocked", "metadata" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

describe("a moderator's rating", () => {
  it('refuses a song its scans have not given their verdict on, and writes nothing', async () => {
    for (const ingestion of ['Pending', 'Rescan', 'Error']) {
      await db.query(`UPDATE "Image" SET "ingestion" = $1 WHERE id = $2`, [ingestion, SONG]);
      const refusal = updateImageNsfwLevel({ id: SONG, nsfwLevel: 8, userId: 1 });
      await expect(refusal).rejects.toBeInstanceOf(SongRatingRefusedError);
      await expect(refusal).rejects.toThrow(/not been reviewed yet/);
      expect(await row(SONG)).toEqual({ nsfwLevel: 1, nsfwLevelLocked: false, metadata: {} });
    }
  });

  it('refuses a removed song as removed, and writes nothing', async () => {
    for (const ingestion of ['Blocked', 'NotFound']) {
      await db.query(`UPDATE "Image" SET "ingestion" = $1 WHERE id = $2`, [ingestion, SONG]);
      const refusal = updateImageNsfwLevel({ id: SONG, nsfwLevel: 8, userId: 1 });
      await expect(refusal).rejects.toBeInstanceOf(SongRatingRefusedError);
      await expect(refusal).rejects.toThrow("This song was removed, so it can't be rated.");
      expect(await row(SONG)).toEqual({ nsfwLevel: 1, nsfwLevelLocked: false, metadata: {} });
    }
  });

  it('refuses a song a rescan returned to Pending between the read and the write', async () => {
    // Another writer commits between this writer's read and its UPDATE: the read saw Scanned.
    let raced = false;
    const racing = new Proxy(db, {
      get(target, key) {
        if (key === 'query')
          return async (text: string, params?: unknown[]) => {
            if (!raced && /^update "Image"/i.test(text.trim())) {
              raced = true;
              await target.query(`UPDATE "Image" SET "ingestion" = 'Pending' WHERE id = $1`, [
                REVIEWED_SONG,
              ]);
            }
            return target.query(text, params);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const before = dbHandle.current;
    dbHandle.current = new Kysely({ dialect: pgliteDialect(racing) });
    try {
      const refusal = updateImageNsfwLevel({ id: REVIEWED_SONG, nsfwLevel: 8, userId: 1 });
      await expect(refusal).rejects.toBeInstanceOf(SongRatingRefusedError);
      await expect(refusal).rejects.toThrow('This song changed while it was being rated. Reload.');
    } finally {
      dbHandle.current = before;
    }
    expect(raced).toBe(true);
    expect(await row(REVIEWED_SONG)).toEqual({
      nsfwLevel: 1,
      nsfwLevelLocked: false,
      metadata: {},
    });
  });

  it('rates a song its own scans already reviewed, as it rates a picture', async () => {
    await updateImageNsfwLevel({ id: REVIEWED_SONG, nsfwLevel: 8, userId: 1, reason: 'mod' });

    expect(await row(REVIEWED_SONG)).toEqual({
      nsfwLevel: 8,
      nsfwLevelLocked: true,
      metadata: { nsfwLevelReason: 'mod' },
    });
  });

  // Regression for every caller that rates outside a transaction (queues, lookup, Inquisitor).
  it('called on its own, writes and then runs its cache, activity and search work, as before', async () => {
    const { invalidateThumbnails } = await import('../thumbnail-cache');
    const { bustProfilePictures } = await import('../profile-picture-cache');
    const { recordModActivity } = await import('../mod-activity');
    const { bustCachedObject } = await import('../cache');
    const { queueDocumentsForImageMinorChanges } = await import('../image-models-reindex');

    await updateImageNsfwLevel({ id: REVIEWED_SONG, nsfwLevel: 8, userId: 4 });

    expect((await row(REVIEWED_SONG)).nsfwLevelLocked).toBe(true);
    expect(invalidateThumbnails).toHaveBeenCalledWith(REVIEWED_SONG, [null]);
    expect(bustProfilePictures).toHaveBeenCalledWith({ imageIds: [REVIEWED_SONG] });
    expect(recordModActivity).toHaveBeenCalledWith({
      userId: 4,
      entityType: 'image',
      entityId: REVIEWED_SONG,
      activity: 'setNsfwLevel',
    });
    expect(bustCachedObject).toHaveBeenCalledWith(expect.any(String), REVIEWED_SONG);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({
      levelImageIds: [REVIEWED_SONG],
    });
  });
});
