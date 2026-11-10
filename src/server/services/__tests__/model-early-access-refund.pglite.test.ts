import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * The partial-refund write runs against PGlite: a buyer refunded for a recent download keeps the
 * older generation purchase, and whatever else the grant carried. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  refundMultiAccountTransaction: vi.fn(),
  getUserBuzzAccountByAccountTypes: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => mocks);

const { refundModelEarlyAccessPurchases } = await import(
  '~/server/services/model-early-access-refund.service'
);

const VERSION_ID = 501;
const BUYER_ID = 77;
const OTHER_BUYER_ID = 78;
const MODEL_ID = 9;

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
  dbMock.dbWrite.$executeRaw.mockImplementation(pgliteRaw(db).executeRaw as never);
  dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({ name: 'Model', userId: 1 } as never);
  mocks.getUserBuzzAccountByAccountTypes.mockResolvedValue({ yellow: 10_000 });
});

const seed = (accessorId: number, permissions: number, meta: Record<string, unknown>) =>
  db.query(`INSERT INTO "EntityAccess" VALUES ($1, 'ModelVersion', $2, 'User', $3, $4::jsonb)`, [
    VERSION_ID,
    accessorId,
    permissions,
    JSON.stringify(meta),
  ]);

const grantOf = async (accessorId: number) =>
  (
    await db.query<{ permissions: number; meta: Record<string, unknown> }>(
      `SELECT permissions, meta FROM "EntityAccess" WHERE "accessorId" = $1`,
      [accessorId]
    )
  ).rows[0];

describe('refundModelEarlyAccessPurchases — narrowing a grant on Postgres', () => {
  it('removes only the refunded download, keeping generation, its meta and the other buyer', async () => {
    const kept = { 'generation-buzzTransactionId': 'tx-gen', note: 'unrelated' };
    await seed(BUYER_ID, 3, {
      ...kept,
      'download-buzzTransactionId': 'tx-dl',
      'download-purchasedAt': '2026-11-01T00:00:00.000Z',
    });
    await seed(OTHER_BUYER_ID, 3, { 'download-buzzTransactionId': 'tx-other' });

    await refundModelEarlyAccessPurchases({
      modelId: MODEL_ID,
      requirement: {
        purchases: [
          {
            modelVersionId: VERSION_ID,
            buyerId: BUYER_ID,
            buzzTransactionIds: ['tx-dl'],
            narrow: {
              revokePermissions: 2,
              removeKeys: ['download-buzzTransactionId', 'download-purchasedAt'],
            },
          },
        ],
        buyerCount: 1,
        totalBuzz: 500,
        totalsByAccount: { yellow: 500 },
        exemptBuyerCount: 1,
      },
    });

    expect(mocks.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(await grantOf(BUYER_ID)).toEqual({ permissions: 1, meta: kept });
    expect(await grantOf(OTHER_BUYER_ID)).toEqual({
      permissions: 3,
      meta: { 'download-buzzTransactionId': 'tx-other' },
    });
    expect(dbMock.dbWrite.entityAccess.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps a bit no refunded purchase granted, such as one from a gift', async () => {
    // 4 stands in for a permission a gift claim merged into the row.
    await seed(BUYER_ID, 3 | 4, {
      'generation-buzzTransactionId': 'tx-gen',
      'download-buzzTransactionId': 'tx-dl',
    });

    await refundModelEarlyAccessPurchases({
      modelId: MODEL_ID,
      requirement: {
        purchases: [
          {
            modelVersionId: VERSION_ID,
            buyerId: BUYER_ID,
            buzzTransactionIds: ['tx-dl'],
            narrow: { revokePermissions: 2, removeKeys: ['download-buzzTransactionId'] },
          },
        ],
        buyerCount: 1,
        totalBuzz: 500,
        totalsByAccount: { yellow: 500 },
        exemptBuyerCount: 1,
      },
    });

    expect((await grantOf(BUYER_ID)).permissions).toBe(1 | 4);
  });
  const refundNarrow = (revokePermissions: number, removeKeys: string[]) =>
    refundModelEarlyAccessPurchases({
      modelId: MODEL_ID,
      requirement: {
        purchases: [
          {
            modelVersionId: VERSION_ID,
            buyerId: BUYER_ID,
            buzzTransactionIds: ['tx-dl'],
            narrow: { revokePermissions, removeKeys },
          },
        ],
        buyerCount: 1,
        totalBuzz: 500,
        totalsByAccount: { yellow: 500 },
        exemptBuyerCount: 0,
      },
    });

  it("keeps the gift's bits it reads from the row at the write", async () => {
    await seed(BUYER_ID, 3, {
      giftLinkId: 4,
      'gift-permissions': 1,
      'download-buzzTransactionId': 'tx-dl',
    });
    await refundNarrow(3, ['download-buzzTransactionId']);
    expect(await grantOf(BUYER_ID)).toEqual({
      permissions: 1,
      meta: { giftLinkId: 4, 'gift-permissions': 1 },
    });
  });

  it('keeps every bit of a gift row that did not record its bits', async () => {
    await seed(BUYER_ID, 3, { giftLinkId: 4, 'download-buzzTransactionId': 'tx-dl' });
    await refundNarrow(3, ['download-buzzTransactionId']);
    expect((await grantOf(BUYER_ID)).permissions).toBe(3);
  });

  it('takes the refunded bits when the gift was removed after the refund was worked out', async () => {
    // Worked out while the gift stood; by the write, its claim was removed and its keys dropped.
    await seed(BUYER_ID, 3, { 'download-buzzTransactionId': 'tx-dl' });
    await refundNarrow(3, ['download-buzzTransactionId']);
    expect((await grantOf(BUYER_ID)).permissions).toBe(0);
  });
});
