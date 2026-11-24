import { ratingRecordedUnderGrace } from '@civitai/shared/account-deletion-grace';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { restoreAccountDeletionImageBatch } from '~/server/services/account-deletion-images';
import {
  TEST_DATABASE_URL,
  runnerOn,
} from '~/server/services/commentv3/__tests__/two-connection-pg';

/**
 * A moderator's rating that lands while an account restore is claiming the row, on two connections
 * of real Postgres: the moderator's transaction holds the row, the restore starts and waits on it,
 * then the moderator commits. A single-connection database cannot interleave the two.
 */

const OWNER = 8;
const DDL = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
  CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
  CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
  CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "postId" int,
    ingestion "ImageIngestionStatus", "blockedFor" text, "nsfwLevel" int NOT NULL DEFAULT 0,
    "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "needsReview" text, metadata jsonb);
  CREATE TABLE "Appeal" (id serial PRIMARY KEY, "entityType" "EntityType" NOT NULL,
    "entityId" int NOT NULL, status "AppealStatus" NOT NULL DEFAULT 'Pending');`;

describe.skipIf(!TEST_DATABASE_URL)('a moderator rating that races an account restore', () => {
  const schema = `restore_race_${process.pid}`;
  let pool: Pool;

  const admin = async (sql: string) => {
    const c = new Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4, application_name: schema });
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
    const { rows } = await pool.query('SELECT current_schema() AS s');
    expect(rows[0].s).toBe(schema);
    await pool.query(DDL);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  beforeEach(async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation(runnerOn(pool).$queryRaw as never);
    await pool.query(
      `TRUNCATE "Image", "User", "Appeal"; INSERT INTO "User" (id) VALUES (${OWNER})`
    );
  });

  const graced = (id: number, level: number, locked: boolean) =>
    pool.query(
      `INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", metadata)
       VALUES ($1, $2, 'Blocked', 'moderated', 32, $3, $4)`,
      [
        id,
        OWNER,
        locked,
        JSON.stringify({
          accountDeletionPriorIngestion: 'Scanned',
          accountDeletionPriorBlockedFor: null,
          accountDeletionPriorNeedsReview: null,
          accountDeletionPriorNsfwLevel: level,
          accountDeletionPriorNsfwLevelLocked: locked,
        }),
      ]
    );

  /** Whether `done` is seen waiting on a row lock on this pool's connections before it finishes. */
  const waitsOnLock = async (done: Promise<unknown>) => {
    let finished = false;
    void done.then(
      () => (finished = true),
      () => (finished = true)
    );
    for (let i = 0; i < 200; i++) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE application_name = $1 AND wait_event_type = 'Lock'`,
        [schema]
      );
      if (rows[0].n) return 'waiting';
      if (finished) return 'finished';
      await new Promise((r) => setTimeout(r, 25));
    }
    return 'timeout';
  };

  /** A moderator rates the row Blocked, as updateImageNsfwLevel does, committing mid-restore. */
  const restoreRacedByModeratorBlock = async (id: number) => {
    const mod = await pool.connect();
    try {
      await mod.query('BEGIN');
      const { rows } = await mod.query(`SELECT metadata FROM "Image" WHERE id = $1 FOR UPDATE`, [
        id,
      ]);
      await mod.query(
        `UPDATE "Image" SET "nsfwLevel" = 32, "nsfwLevelLocked" = true, metadata = metadata || $2::jsonb
         WHERE id = $1`,
        [id, JSON.stringify(ratingRecordedUnderGrace(rows[0].metadata, 32))]
      );
      const restore = restoreAccountDeletionImageBatch(OWNER);
      // The race is real only if the restore began before the commit and had to wait for it.
      expect(await waitsOnLock(restore)).toBe('waiting');
      await mod.query('COMMIT');
      return await restore;
    } finally {
      mod.release();
    }
  };

  const row = async (id: number) =>
    (
      await pool.query(
        `SELECT ingestion, "nsfwLevel", "nsfwLevelLocked" FROM "Image" WHERE id = $1`,
        [id]
      )
    ).rows[0];

  it.each([
    ['an unlocked rating, which the restore re-rates', 1, false],
    ['a locked rating, which the restore puts back', 4, true],
  ])('keeps the Blocked rating over %s', async (_, level, locked) => {
    await graced(201, level, locked);

    const restored = await restoreRacedByModeratorBlock(201);

    expect(await row(201)).toEqual({ ingestion: 'Scanned', nsfwLevel: 32, nsfwLevelLocked: true });
    // A row without a recordedLevel goes to the caller's re-rate, which unlocks and recomputes it.
    expect(restored.map((r) => [r.id, r.recordedLevel])).toEqual([[201, 32]]);
  });
});
