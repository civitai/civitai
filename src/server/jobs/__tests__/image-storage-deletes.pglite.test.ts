import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The job's own SQL against Postgres: what it reads, what it removes and what it marks. The
 * mocked-SQL suite (`image-storage-deletes.test.ts`) pins the statements' shape; this pins what
 * they do to the rows, including a row of another queue type for the same image.
 */

const { mockDeleteImageFromS3 } = vi.hoisted(() => ({ mockDeleteImageFromS3: vi.fn() }));

// Hand-listed rather than spread from the real module, which builds module-scope caches on import.
vi.mock('~/server/services/image.service', () => ({ deleteImageFromS3: mockDeleteImageFromS3 }));
vi.mock('~/env/other', () => ({ isProd: true }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { imageStorageDeletes } from '~/server/jobs/image-storage-deletes';

vi.setConfig({ hookTimeout: 60_000 });

const DELETED_ID = 21;
const SKIPPED_ID = 22;
const FAILED_ID = 23;
const QUEUED_AT = '2026-01-01 00:00:00';

const OUTCOMES: Record<string, 'deleted' | 'skipped' | 'failed'> = {
  'key-deleted': 'deleted',
  'key-skipped': 'skipped',
  'key-failed': 'failed',
};

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM ('ImageStorageDelete', 'BlockedImageDelete');
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("entityType", "entityId", type)
    );
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  setEnv({ DATABASE_IS_PROD: true });
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  mockDeleteImageFromS3.mockImplementation(async ({ url }: { url: string }) => OUTCOMES[url]);
  await db.exec(`
    TRUNCATE "JobQueue";
    INSERT INTO "JobQueue" ("entityId", "entityType", type, data, "createdAt") VALUES
      (${DELETED_ID}, 'Image', 'ImageStorageDelete', '{"url": "key-deleted"}', '${QUEUED_AT}'),
      (${SKIPPED_ID}, 'Image', 'ImageStorageDelete', '{"url": "key-skipped"}', '${QUEUED_AT}'),
      (${FAILED_ID}, 'Image', 'ImageStorageDelete', '{"url": "key-failed"}', '${QUEUED_AT}'),
      -- Another queue's row for an image whose storage delete succeeds.
      (${DELETED_ID}, 'Image', 'BlockedImageDelete', NULL, '${QUEUED_AT}');
  `);
});

const runJob = () =>
  imageStorageDeletes.run({} as Parameters<typeof imageStorageDeletes.run>[0]).result as Promise<
    Record<string, unknown>
  >;

const queueRows = async () =>
  (
    await db.query<{ entityId: number; type: string; data: unknown; createdAt: string }>(
      `SELECT "entityId", type::text AS type, data, to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS') AS "createdAt"
       FROM "JobQueue" ORDER BY "entityId", type`
    )
  ).rows;

describe('image-storage-deletes against Postgres', () => {
  it('removes deleted and skipped keys, keeps a failed one marked and unaged, and leaves other queues alone', async () => {
    expect(await runJob()).toMatchObject({ deleted: 1, skipped: 1, failed: 1 });

    expect(mockDeleteImageFromS3.mock.calls.map(([arg]) => arg.id).sort()).toEqual([
      DELETED_ID,
      SKIPPED_ID,
      FAILED_ID,
    ]);
    expect(await queueRows()).toEqual([
      { entityId: DELETED_ID, type: 'BlockedImageDelete', data: null, createdAt: QUEUED_AT },
      {
        entityId: FAILED_ID,
        type: 'ImageStorageDelete',
        data: { url: 'key-failed', attempted: true },
        createdAt: QUEUED_AT,
      },
    ]);
  });

  it('keeps a row a delete upgraded to every version while this run deleted its key', async () => {
    mockDeleteImageFromS3.mockImplementation(async ({ id, url }: { id: number; url: string }) => {
      if (id === DELETED_ID)
        await db.exec(
          `UPDATE "JobQueue" SET data = '{"url": "key-deleted", "allVersions": true}'
           WHERE "entityId" = ${DELETED_ID} AND type = 'ImageStorageDelete'`
        );
      return OUTCOMES[url];
    });

    await runJob();

    expect(
      (await queueRows()).filter((row) => row.type === 'ImageStorageDelete').map((row) => row.data)
    ).toEqual([
      { url: 'key-deleted', allVersions: true },
      { url: 'key-failed', attempted: true },
    ]);
  });

  it('retries a failed key without purging again, and keeps it while it still fails', async () => {
    await runJob();
    mockDeleteImageFromS3.mockClear();

    await runJob();

    expect(mockDeleteImageFromS3).toHaveBeenCalledTimes(1);
    expect(mockDeleteImageFromS3.mock.calls[0][0]).toMatchObject({
      id: FAILED_ID,
      url: 'key-failed',
      purgeOnFailure: false,
    });
    expect((await queueRows()).filter((row) => row.type === 'ImageStorageDelete')).toEqual([
      {
        entityId: FAILED_ID,
        type: 'ImageStorageDelete',
        data: { url: 'key-failed', attempted: true },
        createdAt: QUEUED_AT,
      },
    ]);
  });

  // Newest first, so one delete is not queued behind a whole account's wipe; a retry after all of
  // them, so keys that keep failing cannot hold back new deletes.
  it('takes the newest first-attempts first, and retries after them', async () => {
    await db.exec(`
      TRUNCATE "JobQueue";
      INSERT INTO "JobQueue" ("entityId", "entityType", type, data, "createdAt") VALUES
        (31, 'Image', 'ImageStorageDelete', '{"url": "key-deleted"}', '2026-01-01'),
        (32, 'Image', 'ImageStorageDelete', '{"url": "key-deleted"}', '2026-01-02'),
        (33, 'Image', 'ImageStorageDelete', '{"url": "key-deleted", "attempted": true}', '2026-01-03');
    `);

    await runJob();

    expect(mockDeleteImageFromS3.mock.calls.map(([arg]) => arg.id)).toEqual([32, 31, 33]);
  });

  // A share of each run goes to the oldest rows, so a wipe's newer rows cannot crowd an old one out of the batch.
  it('still takes the oldest first attempt behind more newer rows than one run takes', async () => {
    await db.exec(`
      TRUNCATE "JobQueue";
      INSERT INTO "JobQueue" ("entityId", "entityType", type, data, "createdAt") VALUES
        (1, 'Image', 'ImageStorageDelete', '{"url": "key-deleted"}', '2025-01-01');
      INSERT INTO "JobQueue" ("entityId", "entityType", type, data, "createdAt")
      SELECT 1000 + n, 'Image', 'ImageStorageDelete', '{"url": "key-deleted"}',
        timestamp '2026-01-01' + n * interval '1 second'
      FROM generate_series(1, 600) n;
    `);

    await runJob();

    const taken = mockDeleteImageFromS3.mock.calls.map(([arg]) => arg.id);
    expect(taken).toContain(1);
    expect(taken.slice(0, 3)).toEqual([1600, 1599, 1598]);
  });
});
