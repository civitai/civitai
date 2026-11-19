import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CacheContext } from '../common/caches/base';
import { profilePictures } from '../common/caches/imageData.cache';

const CLEAN_USER = 1;
const BLOCKED_USER = 2;
const FLAGGED_USER = 3;
const PENDING_USER = 4;
const OTHER_REVIEW_USER = 5;
const UNRATED_USER = 6;
const MOD_RATED_USER = 7;
const MINOR_USER = 8;

let pg: PGlite;

/** A redis that holds nothing, so every fetch reads Postgres. */
const emptyRedis = {
  hGetAll: async () => ({}),
  set: async () => 'OK',
  hSet: async () => 1,
  expire: async () => true,
  del: async () => 1,
};

const ctx = (): CacheContext =>
  ({
    pg: { query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params)).rows },
    ch: { query: async () => [] },
    redis: emptyRedis,
  } as unknown as CacheContext);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1, hash text,
      type text NOT NULL DEFAULT 'image', width int, height int, metadata jsonb,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "scanJobs" jsonb
    );
    CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int);
    INSERT INTO "Image" (id, url, ingestion, "needsReview") VALUES
      (10, 'clean', 'Scanned', NULL),
      (20, 'blocked', 'Blocked', NULL),
      (30, 'flagged', 'Scanned', 'csam'),
      (40, 'pending', 'Pending', NULL),
      (50, 'other-review', 'Scanned', 'other-review');
    INSERT INTO "Image" (id, url, ingestion, "nsfwLevel") VALUES (60, 'unrated', 'Scanned', 0);
    INSERT INTO "Image" (id, url, ingestion, "nsfwLevelLocked") VALUES (70, 'pending-mod-rated', 'Pending', true);
    INSERT INTO "Image" (id, url, ingestion, "needsReview") VALUES (80, 'minor', 'Scanned', 'minor');
    INSERT INTO "User" (id, "profilePictureId") VALUES
      (${CLEAN_USER}, 10), (${BLOCKED_USER}, 20), (${FLAGGED_USER}, 30), (${PENDING_USER}, 40), (${OTHER_REVIEW_USER}, 50), (${UNRATED_USER}, 60), (${MOD_RATED_USER}, 70), (${MINOR_USER}, 80);
  `);
});
afterAll(() => pg.close());

describe('profilePictures cache', () => {
  it('serves no picture for a user whose picture may not be served', async () => {
    const result = await profilePictures.fetch(ctx(), [
      CLEAN_USER,
      BLOCKED_USER,
      FLAGGED_USER,
      PENDING_USER,
      OTHER_REVIEW_USER,
      UNRATED_USER,
      MOD_RATED_USER,
      MINOR_USER,
    ]);

    expect(result[CLEAN_USER]).toMatchObject({ id: 10, url: 'clean' });
    // A moderator's rating stands in for a scan, as in the main app.
    expect(result[MOD_RATED_USER]).toMatchObject({ id: 70, url: 'pending-mod-rated' });
    expect(result[OTHER_REVIEW_USER]).toMatchObject({ id: 50, url: 'other-review' });
    expect(result).not.toHaveProperty(String(BLOCKED_USER));
    expect(result).not.toHaveProperty(String(FLAGGED_USER));
    expect(result).not.toHaveProperty(String(MINOR_USER));
    expect(result).not.toHaveProperty(String(UNRATED_USER));
    // Rated but not yet scanned: its scan's checks have not run.
    expect(result).not.toHaveProperty(String(PENDING_USER));
  });
});
