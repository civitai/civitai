import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
} from '../../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock('~/server/db/pgDb', () => {
  const pool = {
    cancellableQuery: async (text: string, values?: unknown[]) => ({
      cancel: async () => undefined,
      result: async () => (await holder.db.query(text, values)).rows,
    }),
  };
  return { pgDbRead: pool, pgDbReadLong: pool, pgDbWrite: pool };
});

const { reprocessExemptBatch } = await import(
  '~/server/api-routes/admin/temp/reprocess-exempt-blocked-images'
);

// 1 shares its url with 3, a CSAM block, so it is withheld from a moderator without the grant.
const WITHHELD = 1;
const PLAIN = 2;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    ${CSAM_LINK_TABLES_SQL}
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL, ingestion text, "needsReview" text,
      "blockedFor" text, "userId" int, "pHash" bigint);
    ${WITHHELD_TABLES_SQL}
    CREATE TYPE "JobQueueType" AS ENUM ('ImageScan');
    CREATE TYPE "EntityType" AS ENUM ('Image');
    CREATE TABLE "JobQueue" (type "JobQueueType", "entityType" "EntityType", "entityId" int,
      PRIMARY KEY (type, "entityType", "entityId"));
  `);
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "Image", "JobQueue";
    INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
      (${WITHHELD}, 'shared', 'Blocked', 'AiNotVerified', 7),
      (${PLAIN}, 'plain', 'Blocked', 'AiNotVerified', 7),
      (3, 'shared', 'Blocked', 'CSAM', 8);
  `);
});

describe('reprocessing exempt blocked images', () => {
  it('leaves an image withheld from a moderator without the grant blocked, and unqueued', async () => {
    expect(await reprocessExemptBatch([WITHHELD, PLAIN])).toEqual([PLAIN]);
    const { rows } = await holder.db.query<{ id: number; ingestion: string }>(
      `SELECT id, ingestion FROM "Image" WHERE id = ANY($1) ORDER BY id`,
      [[WITHHELD, PLAIN]]
    );
    expect(rows).toEqual([
      { id: WITHHELD, ingestion: 'Blocked' },
      { id: PLAIN, ingestion: 'Rescan' },
    ]);
    const queued = await holder.db.query<{ entityId: number }>(`SELECT "entityId" FROM "JobQueue"`);
    expect(queued.rows).toEqual([{ entityId: PLAIN }]);
  });
});
