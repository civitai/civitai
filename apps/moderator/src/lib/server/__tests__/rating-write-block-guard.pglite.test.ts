import type { PGlite } from '@electric-sql/pglite';
import type { DB } from '@civitai/db-schema/kysely';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
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

const { updateImageNsfwLevel, BlockedImageRatingError } = await import('../image-nsfw-level');
const { recordModActivity } = await import('../mod-activity');

const SCHEMA = `
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "ingestion" "ImageIngestionStatus" NOT NULL,
  "blockedFor" TEXT,
  "metadata" JSONB,
  "postId" INTEGER,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE "ImageRatingRequest" ("imageId" INTEGER, "status" TEXT);
`;

const IMAGE_ID = 41;
let db: PGlite;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely<DB>({ dialect: pgliteDialect(db) });
});
afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const seed = (ingestion: string, nsfwLevel: number, blockedFor: string | null) =>
  db.query(
    `INSERT INTO "Image" ("id", "ingestion", "nsfwLevel", "blockedFor", "postId", "metadata")
     VALUES ($1, $2, $3, $4, 9, '{}')`,
    [IMAGE_ID, ingestion, nsfwLevel, blockedFor]
  );
const level = async () =>
  (
    await db.query<{ nsfwLevel: number; nsfwLevelLocked: boolean }>(
      `SELECT "nsfwLevel", "nsfwLevelLocked" FROM "Image" WHERE "id" = $1`,
      [IMAGE_ID]
    )
  ).rows[0];
const rate = (nsfwLevel: number) =>
  updateImageNsfwLevel({ csamReview: true, id: IMAGE_ID, nsfwLevel, userId: 2 });

describe("policy: a rating write doesn't move a blocked row's level; re-blocking to 32 is allowed", () => {
  it.each([
    ['ingestion Blocked', 'Blocked', 4, null],
    ['the Blocked level', 'Scanned', 32, null],
    ['a block reason', 'Scanned', 4, 'moderated'],
  ] as const)(
    'marked by %s: refused with the plain error, nothing written',
    async (_, ingestion, nsfwLevel, reason) => {
      await seed(ingestion, nsfwLevel, reason);

      const refusal = rate(1);
      await expect(refusal).rejects.toBeInstanceOf(BlockedImageRatingError);
      await expect(refusal).rejects.toThrow(
        `Image ${IMAGE_ID} is blocked: lift the block before rating it.`
      );

      expect(await level()).toEqual({ nsfwLevel, nsfwLevelLocked: false });
      expect(recordModActivity).not.toHaveBeenCalled();
    }
  );

  it('re-blocking it to 32 is written', async () => {
    await seed('Blocked', 4, 'moderated');

    await rate(32);

    expect(await level()).toEqual({ nsfwLevel: 32, nsfwLevelLocked: true });
  });

  it('control: an unmarked image is rated and locked', async () => {
    await seed('Scanned', 4, null);

    await rate(1);

    expect(await level()).toEqual({ nsfwLevel: 1, nsfwLevelLocked: true });
    expect(recordModActivity).toHaveBeenCalledTimes(1);
  });
});

describe('a row that vanishes between the read and the write', () => {
  it('says not found, not blocked', async () => {
    await seed('Scanned', 4, null);
    const query = db.query.bind(db);
    // Deleted after the read the write starts from, before the write itself.
    db.query = (async (text: string, ...rest: unknown[]) => {
      if (/^update "Image"/i.test(text.trim()))
        await query(`DELETE FROM "Image" WHERE "id" = $1`, [IMAGE_ID]);
      return query(text, ...(rest as []));
    }) as typeof db.query;

    const refusal = rate(1);
    await expect(refusal).rejects.toThrow('Image not found');
    await expect(refusal).rejects.not.toBeInstanceOf(BlockedImageRatingError);
  });
});
