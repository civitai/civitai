import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * A model version grant a moderator revoked, kept with no permissions as the purchase record, is no
 * access for the callers that ask without naming permissions. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock('~/server/redis/caches', () => ({
  modelVersionAccessCache: { fetch: mocks.fetch },
  lookupModelVersionAccess: mocks.lookup,
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(async () => ({})),
  bustModelSaleCache: vi.fn(),
}));

const { hasEntityAccess } = await import('~/server/services/common.service');

const ENTITY_ID = 501;
const OWNER = 5;
const VIEWER = 77;

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

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`TRUNCATE "EntityAccess"`);
  dbMock.dbWrite.$queryRaw.mockImplementation(pgliteRaw(db).queryRaw as never);
  const privateEntity = { entityId: ENTITY_ID, userId: OWNER, availability: 'Private' };
  mocks.fetch.mockResolvedValue({});
  mocks.lookup.mockResolvedValue({ [ENTITY_ID]: privateEntity });
  dbMock.dbRead.$queryRaw.mockResolvedValue([privateEntity] as never);
});

const grant = (accessToType: string, permissions: number, meta: object = {}) =>
  db.query(`INSERT INTO "EntityAccess" VALUES ($1, $2, $3, 'User', $4, $5::jsonb)`, [
    ENTITY_ID,
    accessToType,
    VIEWER,
    permissions,
    JSON.stringify(meta),
  ]);

const access = async (entityType: 'ModelVersion' | 'Post') =>
  (await hasEntityAccess({ entityType, entityIds: [ENTITY_ID], userId: VIEWER }))[0].hasAccess;

describe('hasEntityAccess with no permissions named', () => {
  it("grants a buyer's model version grant", async () => {
    await grant('ModelVersion', 3);
    expect(await access('ModelVersion')).toBe(true);
  });

  it('refuses a model version grant a moderator revoked', async () => {
    await grant('ModelVersion', 0, { revocations: [{ revokedById: 1 }] });
    expect(await access('ModelVersion')).toBe(false);
  });

  it('still grants a model version grant from before permissions were recorded', async () => {
    await grant('ModelVersion', 0);
    expect(await access('ModelVersion')).toBe(true);
  });

  it('still reads any other entity type by the row alone', async () => {
    await grant('Post', 0);
    expect(await access('Post')).toBe(true);
  });
});
