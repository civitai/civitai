import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { recordedOwnership } from './model-ownership-db';
import type * as AccountDeletionImages from '~/server/services/account-deletion-images';
import type * as PaidAccessService from '~/server/services/paid-access.service';
import type * as UserRestrictionService from '~/server/services/user-restriction.service';

const { bustForModels, auditRows } = vi.hoisted(() => ({
  bustForModels: vi.fn(),
  auditRows: vi.fn(),
}));

vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaidAccessService>()),
  bustModelSaleCacheForModels: bustForModels,
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: auditRows } }));
vi.mock('~/server/services/user-restriction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserRestrictionService>()),
  reopenGenerationRestrictionsOfRestoredAccount: vi.fn(async () => 0),
}));
vi.mock('~/server/services/account-deletion-images', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountDeletionImages>()),
  releaseAccountDeletionPendingDeletes: vi.fn(() => 'release-statement'),
  recordPendingImageRestore: vi.fn(async () => true),
  countPendingAccountDeletionImageRestores: vi.fn(async () => 0),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  userBasicCache: { refresh: vi.fn(async () => undefined) },
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  usersSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));

import { restoreUser } from '~/server/services/user.service';

const USER_ID = 7;
// The account created three models; only two are still orphaned, so only those two are restored.
const AUDITED = [31, 52, 83];
const ORPHANED = [31, 83];
const OTHER_USER = 8;

/** The Transfer events, of `transferred`, on the models a Transfer query asks about by id. */
const transfersAmong = (query: string, transferred: number[]) => {
  const asked = /type = 'Transfer' AND modelId IN \(([\d,]+)\)/
    .exec(query)?.[1]
    .split(',')
    .map(Number);
  return transferred.filter((modelId) => asked?.includes(modelId)).map((modelId) => ({ modelId }));
};

const restore = () =>
  restoreUser({ id: USER_ID, username: 'back', email: 'back@x.com', restoreModels: true });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findFirst.mockImplementation(async ({ where }: { where: { id?: number } }) =>
    where.id === USER_ID
      ? { id: USER_ID, deletedAt: new Date('2026-07-28T00:00:00Z'), meta: {} }
      : null
  );
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID });
  auditRows.mockImplementation(async (query: string) =>
    query.includes("'Create'") ? AUDITED.map((modelId) => ({ modelId })) : []
  );
  dbMock.dbWrite.$queryRaw.mockResolvedValue(ORPHANED.map((id) => ({ id })));
  dbMock.dbWrite.model.updateMany.mockResolvedValue({ count: ORPHANED.length });
  bustForModels.mockResolvedValue(undefined);
});

describe('restoreUser -> model sale badge cache', () => {
  it('busts the restored models', async () => {
    await restore();
    expect(bustForModels).toHaveBeenCalledWith(ORPHANED);
  });

  it('still restores when the bust fails', async () => {
    bustForModels.mockRejectedValue(new Error('redis down'));
    await expect(restore()).resolves.toMatchObject({ id: USER_ID, modelIds: ORPHANED });
  });
});

describe('restoreUser -> model ownership history', () => {
  it('records the user as an owner of each model it gives back, with the reclaim', async () => {
    dbMock.dbWrite.$executeRaw.mockImplementation(((sql: Prisma.Sql) => ({
      sql: sql.sql,
      text: sql.text,
      values: sql.values,
    })) as never);
    dbMock.dbWrite.$transaction.mockImplementation((async (ops: unknown) =>
      Array.isArray(ops) ? ops : undefined) as never);

    await restore();

    const reclaim = dbMock.dbWrite.$transaction.mock.calls
      .map(([ops]) => ops)
      .find((ops) => Array.isArray(ops) && ops.length === 5) as
      | [unknown, unknown, unknown, unknown, { sql: string; text: string; values: unknown[] }]
      | undefined;
    expect(reclaim, 'the reclaim and its ownership rows must commit together').toBeDefined();
    // The reclaim's own owner write, then its ownership statement, against Postgres.
    const rows = await recordedOwnership(
      ORPHANED.map((id) => [id, -1]),
      [
        (db) =>
          db.query(`UPDATE "Model" SET "userId" = $1 WHERE id = ANY($2)`, [USER_ID, ORPHANED]),
        reclaim![4],
      ]
    );
    expect(rows).toEqual(
      ORPHANED.map((modelId) => ({ modelId, userId: USER_ID, reason: 'restore', actorId: null }))
    );
  });
});

describe("restoreUser -> which orphaned models are the account's", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);`);
    await db.exec(
      readFileSync(
        path.resolve(
          __dirname,
          '../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_model_ownership/migration.sql'
        ),
        'utf8'
      )
    );
    // Every model below sits with the placeholder owner.
    await db.exec(`
      INSERT INTO "Model" VALUES (1, -1), (2, -1), (3, -1), (4, -1), (5, -1), (6, -1);
      INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES
        -- created, then moved to the placeholder when the account was deleted: theirs
        (1, ${USER_ID}, 'create'), (1, -1, 'account-delete'),
        -- created, transferred away, and the new owner's account deleted: not theirs
        (2, ${USER_ID}, 'create'), (2, ${OTHER_USER}, 'transfer'), (2, -1, 'account-delete'),
        -- backfilled: the placeholder baseline, then the creator from the analytics store: theirs
        (4, -1, 'baseline'), (4, ${USER_ID}, 'baseline'),
        -- someone else's, which this account's analytics events also name: not theirs
        (5, ${OTHER_USER}, 'create'), (5, -1, 'account-delete');
      -- 3 and 6 have no history: the analytics events decide
    `);
  });
  afterAll(() => db.close());

  it("reclaims the models whose last owner before the placeholder was this account's", async () => {
    // Create events by this account: 3 and 6 have no history, 2 and 5 do and are someone else's. 6
    // was transferred after, so whoever had it last is unknown.
    auditRows.mockImplementation(async (query: string) =>
      query.includes("'Transfer'")
        ? transfersAmong(query, [6])
        : [{ modelId: 2 }, { modelId: 3 }, { modelId: 5 }, { modelId: 6 }]
    );
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      return (await db.query(sql.text, sql.values as unknown[])).rows;
    }) as never);

    await expect(restore()).resolves.toMatchObject({ modelIds: [1, 3, 4] });
  });
});

describe('restoreUser -> the purge it disarms', () => {
  afterEach(() => {
    dbMock.dbWrite.$executeRaw.mockReset();
    dbMock.dbWrite.$transaction.mockReset();
  });

  // The real restore, with the real disarm against Postgres: catches the disarm dropped from the
  // restore, reverted to every image of the account, or preceded by a breadcrumb strip in the restore.
  it('drops the grace purge and keeps the purge of a block written during the grace period', async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
      CREATE TYPE "JobQueueType" AS ENUM ('BlockedImageDelete');
      CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, metadata jsonb);
      CREATE TABLE "JobQueue" (
        "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
        UNIQUE ("entityType", "entityId", type)
      );
      INSERT INTO "Image" VALUES
        (1, ${USER_ID}, '{"accountDeletionPriorIngestion": "Scanned"}'),
        (2, ${USER_ID}, '{}');
      INSERT INTO "JobQueue" VALUES (1, 'Image', 'BlockedImageDelete'), (2, 'Image', 'BlockedImageDelete');
    `);
    dbMock.dbWrite.$executeRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      return (await db.query(sql.text, sql.values as unknown[])).affectedRows ?? 0;
    }) as never);
    dbMock.dbWrite.$transaction.mockImplementation((async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : undefined) as never);

    await restoreUser({ id: USER_ID, username: 'back', email: 'back@x.com', restoreModels: false });

    const { rows } = await db.query<{ entityId: number }>(`SELECT "entityId" FROM "JobQueue"`);
    expect(rows.map((r) => r.entityId)).toEqual([2]);
    await db.close();
  });
});
