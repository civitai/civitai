import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A song is published only by its own scan. A moderator's rating locks the level, and a locked level
 * counts as reviewed, so the rating writer refuses a song and writes nothing. A picture's rating is
 * covered in image-nsfw-level-models-reindex.test.ts. Pins the decision of PR #10162.
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
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE "ImageRatingRequest" ("imageId" INTEGER, "status" TEXT);
`;

const SONG = 990000101;

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
    INSERT INTO "Image" ("id", "type") VALUES (${SONG}, 'audio');`);
});

const row = async (id: number) =>
  (
    await db.query<{ nsfwLevel: number; nsfwLevelLocked: boolean; metadata: unknown }>(
      `SELECT "nsfwLevel", "nsfwLevelLocked", "metadata" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

describe("a moderator's rating", () => {
  it('refuses a song and writes nothing', async () => {
    await expect(
      updateImageNsfwLevel({ id: SONG, nsfwLevel: 8, userId: 1 })
    ).rejects.toBeInstanceOf(SongRatingRefusedError);

    expect(await row(SONG)).toEqual({ nsfwLevel: 1, nsfwLevelLocked: false, metadata: {} });
  });
});
