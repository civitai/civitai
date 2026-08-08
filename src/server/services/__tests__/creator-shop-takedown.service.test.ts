import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ErrorHandling from '~/server/utils/errorHandling';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    logToAxiom: vi.fn(),
    shopItemFindUnique: vi.fn(),
    shopItemUpdate: vi.fn(),
    sectionItemDeleteMany: vi.fn(),
    purchaseFindMany: vi.fn(),
    purchaseUpdate: vi.fn(),
    userCosmeticFindMany: vi.fn(),
    userFindUnique: vi.fn(),
    createBuzzTransaction: vi.fn(),
    refundMultiAccountTransaction: vi.fn(),
    refundTransaction: vi.fn(),
    revokeCosmeticsFromUsers: vi.fn(),
    shopItemFindFirst: vi.fn(),
    shopItemUpdateMany: vi.fn(),
    packMemberFindMany: vi.fn(),
    createNotification: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    // findFirst + cosmeticShopItemCosmetic are the pack delist cascade's reads.
    // Takedown reaches them through delistPacksContaining.
    cosmeticShopItem: { findUnique: mocks.shopItemFindUnique, findFirst: mocks.shopItemFindFirst },
    cosmeticShopItemCosmetic: { findMany: mocks.packMemberFindMany },
    userCosmeticShopPurchases: { findMany: mocks.purchaseFindMany },
    userCosmetic: { findMany: mocks.userCosmeticFindMany },
    user: { findUnique: mocks.userFindUnique },
  },
  dbWrite: {
    cosmeticShopItem: {
      findUnique: mocks.shopItemFindUnique,
      update: mocks.shopItemUpdate,
      updateMany: mocks.shopItemUpdateMany,
    },
    cosmeticShopSectionItem: { deleteMany: mocks.sectionItemDeleteMany },
    // Sales and ownership are read off the primary during a takedown — replica
    // lag would mean refunding fewer buyers than we strip the cosmetic from.
    userCosmeticShopPurchases: { findMany: mocks.purchaseFindMany, update: mocks.purchaseUpdate },
    userCosmetic: { findMany: mocks.userCosmeticFindMany },
  },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mocks.createBuzzTransaction,
  refundMultiAccountTransaction: mocks.refundMultiAccountTransaction,
  refundTransaction: mocks.refundTransaction,
}));
vi.mock('~/server/services/cosmetic.service', () => ({
  revokeCosmeticsFromUsers: mocks.revokeCosmeticsFromUsers,
  validateStickerCosmetic: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembership: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mocks.logToAxiom }));
// Real retry semantics, no wall-clock wait — the service's 1s backoff would make
// the failure cases take seconds each.
vi.mock('~/server/utils/errorHandling', async (importOriginal) => {
  const actual = await importOriginal<typeof ErrorHandling>();
  return {
    ...actual,
    withRetries: (fn: () => Promise<unknown>, retries = 3) => actual.withRetries(fn, retries, 0),
  };
});

import { takedownCosmeticShopItem, unarchiveCreatorShopItem } from '../creator-shop.service';

const shopItemRow = {
  id: 42,
  cosmeticId: 7,
  title: 'Infringing Badge',
  meta: { purchases: 2, submissionTxId: 'fee-tx-1' },
  addedById: 11,
  cosmetic: { createdById: 11, creator: { username: 'creator' } },
};

// unitAmount 1000 → creator pool (70%) = 700, platform keeps 300.
// meta: null = a legacy sale, from before payouts were recorded per purchase.
const purchases = [
  { userId: 101, buzzTransactionId: 'purchase-1', unitAmount: 1000, meta: null },
  { userId: 102, buzzTransactionId: 'purchase-2', unitAmount: 1000, meta: null },
];

const yellowRefund = (amount: number) => ({
  refundedTransactions: [
    {
      originalTransactionId: 'o',
      refundTransactionId: 'r',
      accountType: 'yellow',
      amount,
      originalExternalTransactionId: 'e',
    },
  ],
  totalRefunded: amount,
  externalTransactionIdPrefix: 'p',
});

describe('takedownCosmeticShopItem', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindUnique.mockResolvedValue(shopItemRow);
    mocks.shopItemUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 42,
      ...data,
    }));
    mocks.purchaseFindMany.mockResolvedValue(purchases);
    mocks.userCosmeticFindMany.mockResolvedValue([
      { userId: 101 },
      { userId: 102 },
      { userId: 11 }, // the creator's own grant
    ]);
    mocks.userFindUnique.mockResolvedValue({ settings: {} });
    // The delist cascade: no surviving listing, no packs bundling this cosmetic.
    mocks.shopItemFindFirst.mockResolvedValue(null);
    mocks.packMemberFindMany.mockResolvedValue([]);
    mocks.shopItemUpdateMany.mockResolvedValue({ count: 0 });
    mocks.logToAxiom.mockResolvedValue(undefined);
    mocks.refundMultiAccountTransaction.mockResolvedValue(yellowRefund(1000));
    mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'tx' });
    mocks.refundTransaction.mockResolvedValue({ transactionId: 'refund-tx' });
    mocks.revokeCosmeticsFromUsers.mockResolvedValue({ revoked: 3 });
  });

  it('stops sales, refunds every buyer, claws back the creator earnings and strips the cosmetic', async () => {
    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    const update = mocks.shopItemUpdate.mock.calls[0][0];
    expect(update.where).toEqual({ id: 42 });
    expect(update.data.status).toBe('Archived');
    expect(update.data.listed).toBe(false);
    expect(update.data.meta.takedown).toMatchObject({
      reason: 'IP infringement',
      moderatorId: 999,
    });
    expect(mocks.sectionItemDeleteMany).toHaveBeenCalledWith({ where: { shopItemId: 42 } });

    expect(mocks.refundMultiAccountTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'purchase-1' })
    );
    expect(mocks.purchaseUpdate).toHaveBeenCalledWith({
      where: { buzzTransactionId: 'purchase-1' },
      data: { refunded: true },
    });

    // One clawback for both sales: 2 × 700 out of the creator's yellow account.
    expect(mocks.createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: 11, fromAccountType: 'yellow', amount: 1400 })
    );

    expect(mocks.revokeCosmeticsFromUsers).toHaveBeenCalledWith({
      userIds: [101, 102, 11],
      cosmeticIds: [7],
    });

    expect(result).toMatchObject({
      purchases: 2,
      refunded: 2,
      refundedValue: 2000,
      owedBack: 1400,
      clawedBack: 1400,
      // The seller keeps 70% of a sale, so that's what comes back.
      clawedBackPct: 70,
      unrecoveredResellerShare: 0,
      revokedFrom: 3,
      failures: [],
    });
  });

  it('never refunds the creator submission fee', async () => {
    await takedownCosmeticShopItem({ id: 42, reason: 'TOS violation', moderatorId: 999 });

    const refundedIds = mocks.refundTransaction.mock.calls.map(([txId]: [string]) => txId);
    const refundedPrefixes = mocks.refundMultiAccountTransaction.mock.calls.map(
      ([input]: [{ externalTransactionIdPrefix: string }]) => input.externalTransactionIdPrefix
    );
    expect([...refundedIds, ...refundedPrefixes]).not.toContain('fee-tx-1');
  });

  it('refunds blue-paid purchases in the colors they were paid with', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    mocks.refundMultiAccountTransaction.mockResolvedValue({
      refundedTransactions: [
        {
          originalTransactionId: 'o',
          refundTransactionId: 'r',
          accountType: 'blue',
          amount: 400,
          originalExternalTransactionId: 'e',
        },
        {
          originalTransactionId: 'o2',
          refundTransactionId: 'r2',
          accountType: 'green',
          amount: 600,
          originalExternalTransactionId: 'e2',
        },
      ],
      totalRefunded: 1000,
      externalTransactionIdPrefix: 'p',
    });

    await takedownCosmeticShopItem({ id: 42, reason: 'IP infringement', moderatorId: 999 });

    // 700 creator pool, 40% of the price paid in blue → 280 blue + 420 green.
    const clawbacks = mocks.createBuzzTransaction.mock.calls.map(
      ([input]: [{ fromAccountType: string; amount: number }]) => ({
        color: input.fromAccountType,
        amount: input.amount,
      })
    );
    expect(clawbacks).toEqual(
      expect.arrayContaining([
        { color: 'blue', amount: 280 },
        { color: 'green', amount: 420 },
      ])
    );
  });

  it('claws back only the creator share of a legacy resellable sale and reports the rest', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      ...shopItemRow,
      meta: { ...shopItemRow.meta, sellableByOthers: true, sellerShare: 20 },
    });
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    // 700 pool − 200 seller share = 500 recoverable from the creator.
    expect(mocks.createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: 11, amount: 500 })
    );
    expect(result.unrecoveredResellerShare).toBe(200);
    // 500 of a 1000 sale — the reported share follows what's actually recovered.
    expect(result.clawedBackPct).toBe(50);
  });

  it('reverses the recorded payouts verbatim, including a reseller cut', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      ...shopItemRow,
      meta: { ...shopItemRow.meta, sellableByOthers: true, sellerShare: 20 },
    });
    mocks.purchaseFindMany.mockResolvedValue([
      {
        ...purchases[0],
        meta: {
          payouts: [
            { userId: 11, amount: 500, color: 'yellow', transactionId: 'sell-tx-creator' },
            { userId: 55, amount: 200, color: 'yellow', transactionId: 'sell-tx-reseller' },
          ],
          platformCut: 300,
        },
      },
    ]);

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    // The payout transactions are refunded, not reversed by a fresh charge — and
    // the reseller's cut comes back too, the whole point of recording payouts.
    expect(mocks.refundTransaction).toHaveBeenCalledWith(
      'sell-tx-creator',
      expect.stringContaining('Cosmetic removed')
    );
    expect(mocks.refundTransaction).toHaveBeenCalledWith(
      'sell-tx-reseller',
      expect.stringContaining('Cosmetic removed')
    );
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      owedBack: 700,
      clawedBack: 700,
      clawedBackPct: 70,
      unrecoveredResellerShare: 0,
    });
  });

  it('falls back to a reversing charge when a recorded payout has no transaction id', async () => {
    mocks.purchaseFindMany.mockResolvedValue([
      {
        ...purchases[0],
        meta: { payouts: [{ userId: 11, amount: 700, color: 'yellow' }], platformCut: 300 },
      },
    ]);

    await takedownCosmeticShopItem({ id: 42, reason: 'IP infringement', moderatorId: 999 });

    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(mocks.createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: 11, fromAccountType: 'yellow', amount: 700 })
    );
  });

  it('never takes Buzz back from a buyer — only from the seller', async () => {
    await takedownCosmeticShopItem({ id: 42, reason: 'IP infringement', moderatorId: 999 });

    const chargedAccounts = mocks.createBuzzTransaction.mock.calls.map(
      ([input]: [{ fromAccountId: number }]) => input.fromAccountId
    );
    expect(chargedAccounts).toEqual([11]);
    expect(chargedAccounts).not.toContain(101);
    expect(chargedAccounts).not.toContain(102);
  });

  it('retries a transient refund failure instead of writing the sale off', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    mocks.refundMultiAccountTransaction
      .mockRejectedValueOnce(new Error('503 upstream'))
      .mockResolvedValue(yellowRefund(1000));

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    expect(mocks.refundMultiAccountTransaction).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ refunded: 1, failures: [] });
  });

  it('logs a permanently failed refund to Axiom with the ids needed to finish it by hand', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    mocks.refundMultiAccountTransaction.mockRejectedValue(new Error('insufficient bank funds'));

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    // Initial attempt + 3 retries before it's written off.
    expect(mocks.refundMultiAccountTransaction).toHaveBeenCalledTimes(4);
    expect(result.failures).toHaveLength(1);
    expect(mocks.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        name: 'cosmetic-takedown',
        message: 'Buyer refund failed',
        data: expect.objectContaining({
          shopItemId: 42,
          userId: 101,
          buzzTransactionId: 'purchase-1',
          amount: 1000,
        }),
      })
    );
  });

  it('keeps going when one refund fails and reports it instead of clawing back that sale', async () => {
    // Fails past every retry for the first sale, then succeeds for the second.
    mocks.refundMultiAccountTransaction
      .mockRejectedValueOnce(new Error('insufficient bank funds'))
      .mockRejectedValueOnce(new Error('insufficient bank funds'))
      .mockRejectedValueOnce(new Error('insufficient bank funds'))
      .mockRejectedValueOnce(new Error('insufficient bank funds'))
      .mockResolvedValue(yellowRefund(1000));

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    expect(result.refunded).toBe(1);
    expect(result.failures).toEqual([
      { stage: 'refund', userId: 101, amount: 1000, error: 'insufficient bank funds' },
    ]);
    // Only the sale that was actually refunded is clawed back.
    expect(mocks.createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: 11, amount: 700 })
    );
    expect(mocks.purchaseUpdate).toHaveBeenCalledTimes(1);
  });

  it('reports a failed clawback without failing the takedown', async () => {
    mocks.createBuzzTransaction.mockRejectedValue(new Error('insufficient funds'));

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    expect(result.refunded).toBe(2);
    expect(result.clawedBack).toBe(0);
    expect(result.failures).toEqual([
      { stage: 'clawback', userId: 11, amount: 1400, error: 'insufficient funds' },
    ]);
    expect(mocks.revokeCosmeticsFromUsers).toHaveBeenCalled();
  });
});

describe('unarchiveCreatorShopItem', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
  });

  it('refuses to restore a taken-down item', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      id: 42,
      cosmeticId: 7,
      unitAmount: 1000,
      status: 'Archived',
      meta: { takedown: { reason: 'IP infringement', moderatorId: 999, at: '2026-08-03' } },
      addedById: 11,
      cosmetic: { id: 7, createdById: 11, type: 'Badge', data: {} },
      _count: { purchases: 2 },
    });

    await expect(unarchiveCreatorShopItem({ userId: 11, id: 42 })).rejects.toThrow(/taken down/);
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
  });
});
