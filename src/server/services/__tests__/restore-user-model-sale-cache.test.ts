import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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
  disarmAccountDeletionImagePurge: vi.fn(() => 'disarm-statement'),
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
  // While the models sat at userId -1 their sales did not count, so the badge cache holds a
  // "no sale" marker for each of them.
  it('busts the restored models after the restore commits', async () => {
    await expect(restore()).resolves.toMatchObject({ modelIds: ORPHANED });

    expect(bustForModels.mock.calls).toEqual([[ORPHANED]]);
    expect(bustForModels.mock.invocationCallOrder[0]).toBeGreaterThan(
      dbMock.dbWrite.$transaction.mock.invocationCallOrder[0]
    );
  });

  it('a failing bust is logged and the restore still succeeds', async () => {
    bustForModels.mockRejectedValue(new Error('redis down'));

    await expect(restore()).resolves.toMatchObject({ id: USER_ID, modelIds: ORPHANED });

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'restore-user-model-sale-cache',
        source: 'restoreUser',
        userId: USER_ID,
        message: 'redis down',
      })
    );
  });
});

describe('restoreUser -> model ownership history', () => {
  it('records the user as an owner of each model it gives back, with the reclaim', async () => {
    dbMock.dbWrite.$executeRaw.mockImplementation(((sql: { sql: string; values: unknown[] }) => ({
      sql: sql.sql,
      values: sql.values,
    })) as never);
    dbMock.dbWrite.$transaction.mockImplementation((async (ops: unknown) =>
      Array.isArray(ops) ? ops : undefined) as never);

    await restore();

    const reclaim = dbMock.dbWrite.$transaction.mock.calls
      .map(([ops]) => ops)
      .find((ops) => Array.isArray(ops) && ops.length === 2) as
      | [unknown, { sql: string; values: unknown[] }]
      | undefined;
    expect(reclaim, 'the reclaim and its ownership rows must commit together').toBeDefined();
    expect(reclaim![1].sql).toContain('"ModelOwnership"');
    expect(reclaim![1].values).toEqual([USER_ID, 'restore', null, ORPHANED, USER_ID]);
  });

  it('reads only Create events, whose actor is the creator', async () => {
    await restore();

    expect(auditRows.mock.calls[0][0]).toMatch(/type = 'Create'/);
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
        ? [{ modelId: 6 }]
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
