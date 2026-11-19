import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/** The daily challenge's copy of a cover image carries a rating lock only when the lock holds a rating. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });
vi.mock('~/server/events', () => ({ eventEngine: {} }));

const { duplicateImage } = await import('~/server/jobs/daily-challenge-processing');

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Image" (
      id serial PRIMARY KEY, "userId" int, url text, "createdAt" timestamp, "updatedAt" timestamp,
      hash text, height int, width int, meta jsonb, "generationProcess" text, "hideMeta" boolean,
      "mimeType" text, "scanRequestedAt" timestamp, "scannedAt" timestamp, "sizeKB" int,
      nsfw boolean, "blockedFor" text, ingestion text, metadata jsonb, type text, "scanJobs" jsonb,
      "nsfwLevel" int, "nsfwLevelLocked" boolean, "aiNsfwLevel" int, "aiModel" text, "pHash" bigint
    );
    INSERT INTO "Image" (id, "userId", url, ingestion, "nsfwLevel", "nsfwLevelLocked") VALUES
      (1, 5, 'locked-unrated', 'Scanned', 0, true),
      (2, 5, 'locked-pg', 'Scanned', 1, true);
    SELECT setval('"Image_id_seq"', 100);
  `);
  (dbMock.dbWrite.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (text: string) => (await db.query(text)).rows
  );
});
afterAll(() => db.close());

async function lockOfCopy(sourceId: number) {
  const copyId = await duplicateImage(sourceId, 9);
  const { rows } = await db.query<{ nsfwLevel: number; nsfwLevelLocked: boolean }>(
    `SELECT "nsfwLevel", "nsfwLevelLocked" FROM "Image" WHERE id = $1`,
    [copyId]
  );
  return rows[0];
}

describe('duplicateImage', () => {
  it('leaves the copy of an image locked with no rating unlocked, so its scan can rate it', async () => {
    expect(await lockOfCopy(1)).toEqual({ nsfwLevel: 0, nsfwLevelLocked: false });
  });

  it('keeps the lock on the copy of an image locked at a rating', async () => {
    expect(await lockOfCopy(2)).toEqual({ nsfwLevel: 1, nsfwLevelLocked: true });
  });
});
