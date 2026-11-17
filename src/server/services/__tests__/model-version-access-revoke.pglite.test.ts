import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as ModeratorService from '~/server/services/moderator.service';

/**
 * A moderator's revoke of one buyer's early access, against grants held in PGlite. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  buzz: {
    refundMultiAccountTransaction: vi.fn(),
    refundTransaction: vi.fn(),
    createBuzzTransaction: vi.fn(),
    createMultiAccountBuzzTransaction: vi.fn(),
  },
  bustMvCache: vi.fn(),
  trackModActivity: vi.fn(),
}));
// Any Buzz call from the revoke would land on these.
vi.mock('~/server/services/buzz.service', () => mocks.buzz);
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  bustMvCache: mocks.bustMvCache,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: mocks.trackModActivity,
}));

const { moderatorRevokeEarlyAccess } = await import(
  '~/server/services/model-version-access-revoke.service'
);

const VERSION_ID = 501;
const OTHER_VERSION_ID = 502;
const MODEL_ID = 9;
const BUYER_A = 77;
const BUYER_B = 78;
const MODERATOR = 1;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "EntityAccess" (
      "accessToId" int NOT NULL,
      "accessToType" text NOT NULL,
      "accessorId" int NOT NULL,
      "accessorType" text NOT NULL,
      permissions int NOT NULL,
      meta jsonb,
      PRIMARY KEY ("accessToId", "accessToType", "accessorId", "accessorType")
    );
  `);
});

afterAll(async () => {
  await db.close();
});

/** Prisma's deleteMany: removes the rows matching every key the caller passed, and no other. */
const deleteManyOnPglite = async ({ where }: { where: Record<string, unknown> }) => {
  const keys = Object.keys(where);
  const clause = keys.map((key, i) => `"${key}" = $${i + 1}`).join(' AND ');
  const result = await db.query(
    `DELETE FROM "EntityAccess"${keys.length ? ` WHERE ${clause}` : ''}`,
    keys.map((key) => where[key])
  );
  return { count: result.affectedRows ?? 0 };
};

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`TRUNCATE "EntityAccess"`);
  dbMock.dbWrite.entityAccess.deleteMany.mockImplementation(deleteManyOnPglite as never);
  dbMock.dbWrite.entityAccess.findUnique.mockResolvedValue({
    permissions: 3,
    meta: { 'download-buzzTransactionId': 'tx-a' },
    addedAt: new Date('2026-11-01T00:00:00Z'),
  } as never);
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({ modelId: MODEL_ID } as never);
});

const seed = (versionId: number, accessorId: number) =>
  db.query(`INSERT INTO "EntityAccess" VALUES ($1, 'ModelVersion', $2, 'User', 3, '{}'::jsonb)`, [
    versionId,
    accessorId,
  ]);

const grants = async () =>
  (
    await db.query<{ accessToId: number; accessorId: number }>(
      `SELECT "accessToId", "accessorId" FROM "EntityAccess" ORDER BY 1, 2`
    )
  ).rows;

const revokeA = () =>
  moderatorRevokeEarlyAccess({
    moderatorId: MODERATOR,
    userId: BUYER_A,
    modelVersionId: VERSION_ID,
    reason: 'bought the wrong version',
  });

describe('moderatorRevokeEarlyAccess', () => {
  it("removes only that buyer's grant on that version; the other buyer keeps access", async () => {
    await seed(VERSION_ID, BUYER_A);
    await seed(VERSION_ID, BUYER_B);
    await seed(OTHER_VERSION_ID, BUYER_A);

    await expect(revokeA()).resolves.toEqual({ revoked: true, permissions: 3 });

    expect(await grants()).toEqual([
      { accessToId: VERSION_ID, accessorId: BUYER_B },
      { accessToId: OTHER_VERSION_ID, accessorId: BUYER_A },
    ]);
    expect(mocks.trackModActivity).toHaveBeenCalledWith(MODERATOR, {
      entityType: 'modelVersion',
      activity: 'revokeEarlyAccess',
      entityId: VERSION_ID,
    });
    expect(mocks.bustMvCache).toHaveBeenCalledWith(VERSION_ID, MODEL_ID, BUYER_A);
  });

  it('moves no Buzz', async () => {
    await seed(VERSION_ID, BUYER_A);

    await revokeA();

    expect((await grants()).length, 'the revoke did not run, so this proves nothing').toBe(0);
    for (const fn of Object.values(mocks.buzz)) expect(fn).not.toHaveBeenCalled();
  });

  it('is a no-op on a grant that is not there: nothing logged, nothing busted, no error', async () => {
    await seed(VERSION_ID, BUYER_B);
    dbMock.dbWrite.entityAccess.findUnique.mockResolvedValue(null as never);

    await expect(revokeA()).resolves.toEqual({ revoked: false });

    expect(await grants()).toEqual([{ accessToId: VERSION_ID, accessorId: BUYER_B }]);
    expect(mocks.trackModActivity).not.toHaveBeenCalled();
    expect(mocks.bustMvCache).not.toHaveBeenCalled();
  });

  it('logs nothing when the row read beforehand is gone by the delete', async () => {
    // The pre-read still sees the grant; the delete finds nothing.
    await expect(revokeA()).resolves.toEqual({ revoked: false });

    expect(mocks.trackModActivity).not.toHaveBeenCalled();
    expect(mocks.bustMvCache).not.toHaveBeenCalled();
  });
});
