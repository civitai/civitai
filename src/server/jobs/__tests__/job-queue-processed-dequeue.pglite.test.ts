import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { deleteProcessedJobQueueItems } from '~/server/jobs/job-queue';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

vi.setConfig({ hookTimeout: 60_000 });

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Article', 'Model', 'ModelVersion');
    CREATE TYPE "JobQueueType" AS ENUM ('UpdateNsfwLevel', 'CleanUp');
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      UNIQUE ("entityType", "entityId", type)
    );
  `);
});
afterAll(() => db.close());

const READ_AT = '2026-01-01 00:00:00.123';

beforeEach(async () => {
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  await db.exec(`
    TRUNCATE "JobQueue";
    INSERT INTO "JobQueue" ("entityId", "entityType", type, "createdAt") VALUES
      (1, 'Post', 'UpdateNsfwLevel', '${READ_AT}'),
      (2, 'Model', 'UpdateNsfwLevel', '${READ_AT}'),
      (1, 'Post', 'CleanUp', '${READ_AT}');
  `);
});

const remaining = async () =>
  (
    await db.query<{ entityId: number; entityType: string; type: string }>(
      `SELECT "entityId", "entityType"::text AS "entityType", type::text AS type
       FROM "JobQueue" ORDER BY "entityType", "entityId", type`
    )
  ).rows;

describe('deleteProcessedJobQueueItems', () => {
  it('deletes the rows it was handed, of its own type, whatever their entity type', async () => {
    await deleteProcessedJobQueueItems(
      [
        { entityId: 1, entityType: EntityType.Post, createdAt: new Date(`${READ_AT}Z`) },
        { entityId: 2, entityType: EntityType.Model, createdAt: new Date(`${READ_AT}Z`) },
      ],
      JobQueueType.UpdateNsfwLevel
    );

    expect(await remaining()).toEqual([{ entityId: 1, entityType: 'Post', type: 'CleanUp' }]);
  });

  it('keeps a row queued again after it was read', async () => {
    await db.exec(`
      UPDATE "JobQueue" SET "createdAt" = '2026-01-01 00:00:00.124'
      WHERE "entityId" = 1 AND type = 'UpdateNsfwLevel'
    `);

    await deleteProcessedJobQueueItems(
      [{ entityId: 1, entityType: EntityType.Post, createdAt: new Date(`${READ_AT}Z`) }],
      JobQueueType.UpdateNsfwLevel
    );

    expect(await remaining()).toEqual([
      { entityId: 2, entityType: 'Model', type: 'UpdateNsfwLevel' },
      { entityId: 1, entityType: 'Post', type: 'CleanUp' },
      { entityId: 1, entityType: 'Post', type: 'UpdateNsfwLevel' },
    ]);
  });
});
