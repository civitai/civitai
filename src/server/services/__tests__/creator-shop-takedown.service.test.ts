import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ErrorHandling from '~/server/utils/errorHandling';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    logToAxiom: vi.fn(),
    shopItemFindUnique: vi.fn(),
    shopItemUpdate: vi.fn(),
    sectionItemDeleteMany: vi.fn(),
    resaleFindMany: vi.fn(),
    resaleDeleteMany: vi.fn(),
    purchaseFindMany: vi.fn(),
    purchaseUpdate: vi.fn(),
    userCosmeticFindMany: vi.fn(),
    userFindUnique: vi.fn(),
    createBuzzTransaction: vi.fn(),
    refundMultiAccountTransaction: vi.fn(),
    refundTransaction: vi.fn(),
    revokeCosmeticsFromUsers: vi.fn(),
    removePlacementsByCosmetic: vi.fn(),
    shopItemFindFirst: vi.fn(),
    shopItemUpdateMany: vi.fn(),
    packMemberFindMany: vi.fn(),
    createNotification: vi.fn(),
    getMultiAccountTransactionsByPrefix: vi.fn(),
    getTransactionByExternalId: vi.fn(),
  },
}));

// A real mutex that honours `maxRetries`: 0 gives up at once, anything else waits its turn.
// `onWait` lets a test see that a caller is queued behind the holder; `calls` records the options
// each caller asked for.
const lockState = vi.hoisted(() => ({
  held: new Map<string, Promise<void>>(),
  onWait: undefined as undefined | ((key: string) => void),
  // A waiting caller gives up as the real lock does once its retries run out.
  exhausted: false,
  calls: [] as Record<string, unknown>[],
}));
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async (
    options: { key: string; maxRetries?: number },
    operation: () => Promise<unknown>
  ) => {
    const { key, maxRetries } = options;
    lockState.calls.push(options);
    while (lockState.held.has(key)) {
      if (maxRetries === 0 || lockState.exhausted) return null;
      lockState.onWait?.(key);
      await lockState.held.get(key);
    }
    let release!: () => void;
    lockState.held.set(key, new Promise((resolve) => (release = resolve)));
    try {
      return await operation();
    } finally {
      lockState.held.delete(key);
      release();
    }
  },
}));

vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mocks.createBuzzTransaction,
  refundMultiAccountTransaction: mocks.refundMultiAccountTransaction,
  refundTransaction: mocks.refundTransaction,
  getMultiAccountTransactionsByPrefix: mocks.getMultiAccountTransactionsByPrefix,
  getTransactionByExternalId: mocks.getTransactionByExternalId,
}));
vi.mock('~/server/services/cosmetic.service', () => ({
  revokeCosmeticsFromUsers: mocks.revokeCosmeticsFromUsers,
  validateStickerCosmetic: vi.fn(),
}));
vi.mock('~/server/services/placement-moderation.service', () => ({
  removePlacementsByCosmetic: mocks.removePlacementsByCosmetic,
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembership: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mocks.createNotification,
}));
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
import { refundShopPurchases } from '../creator-shop-withdrawn-refund.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.cosmeticShopItem.findFirst.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindFirst as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.cosmeticShopItemCosmetic.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.packMemberFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.userCosmeticShopPurchases.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.purchaseFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.userCosmetic.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.userCosmeticFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.userCosmeticShopItemResale.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.resaleFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.user.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.userFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmeticShopItem.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmeticShopItem.update.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemUpdate as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmeticShopItem.updateMany.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemUpdateMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmeticShopSectionItem.deleteMany.mockImplementation((...args: unknown[]) =>
  (mocks.sectionItemDeleteMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.userCosmeticShopItemResale.deleteMany.mockImplementation((...args: unknown[]) =>
  (mocks.resaleDeleteMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.purchaseFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.userCosmeticShopPurchases.update.mockImplementation((...args: unknown[]) =>
  (mocks.purchaseUpdate as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.userCosmetic.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.userCosmeticFindMany as (...a: unknown[]) => unknown)(...args)
);
loggingMock.logToAxiom.mockImplementation((...args: unknown[]) =>
  (mocks.logToAxiom as (...a: unknown[]) => unknown)(...args)
);

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

describe('takedownCosmeticShopItem on a mystery box listing', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
  });

  // The pack path would refund every box buyer and revoke nothing: a box has no members.
  it('refuses before stopping sales or refunding anyone', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      ...shopItemRow,
      cosmeticId: null,
      cosmetic: null,
      itemDefinitionId: 9,
    });

    await expect(
      takedownCosmeticShopItem({ id: 42, reason: 'r', moderatorId: 999 })
    ).rejects.toThrow('Mystery box listings cannot be taken down here');
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
    expect(mocks.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mocks.refundTransaction).not.toHaveBeenCalled();
  });
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
    mocks.resaleFindMany.mockResolvedValue([]);
    // The delist cascade: no surviving listing, no packs bundling this cosmetic.
    mocks.shopItemFindFirst.mockResolvedValue(null);
    mocks.packMemberFindMany.mockResolvedValue([]);
    mocks.shopItemUpdateMany.mockResolvedValue({ count: 0 });
    mocks.logToAxiom.mockResolvedValue(undefined);
    mocks.refundMultiAccountTransaction.mockResolvedValue(yellowRefund(1000));
    mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'tx' });
    mocks.refundTransaction.mockResolvedValue({ transactionId: 'refund-tx' });
    mocks.revokeCosmeticsFromUsers.mockResolvedValue({ revoked: 3 });
    mocks.removePlacementsByCosmetic.mockResolvedValue({
      considered: 0,
      settled: 0,
      failed: [],
      takenDown: 0,
      hasMore: false,
    });
  });

  // Revoking the holding leaves stickers already placed on other people's
  // images untouched — they live in their own table, keyed by a cosmetic id
  // inside a JSON payload, and nothing else in this takedown looks there.
  it('takes down every placement made with the cosmetic', async () => {
    mocks.removePlacementsByCosmetic.mockResolvedValue({
      considered: 4,
      settled: 1,
      failed: [],
      takenDown: 3,
      hasMore: false,
    });

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'Abusive artwork',
      moderatorId: 999,
    });

    expect(mocks.removePlacementsByCosmetic.mock.calls[0][0]).toMatchObject({
      cosmeticIds: [7],
      actorId: 999,
    });
    expect(result.placementsRemoved).toMatchObject({ settled: 1, takenDown: 3 });
  });

  // Bounded per batch, so one pass would report a clean takedown with the
  // artwork still on other people's work.
  it('drains the placement takedown rather than running one batch', async () => {
    mocks.removePlacementsByCosmetic
      .mockResolvedValueOnce({ considered: 2, settled: 0, failed: [], takenDown: 2, hasMore: true })
      .mockResolvedValueOnce({
        considered: 1,
        settled: 0,
        failed: [],
        takenDown: 1,
        hasMore: false,
      });

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'Abusive artwork',
      moderatorId: 999,
    });

    expect(mocks.removePlacementsByCosmetic).toHaveBeenCalledTimes(2);
    expect(result.placementsRemoved.takenDown).toBe(3);
  });

  // A takedown that aborts because placements could not be removed would leave
  // the buyers unrefunded and the cosmetic on sale.
  it('finishes the takedown even if the placement sweep throws', async () => {
    mocks.removePlacementsByCosmetic.mockRejectedValue(new Error('db is having a moment'));

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'Abusive artwork',
      moderatorId: 999,
    });

    expect(result.revokedFrom).toBe(3);
    expect(result.placementsRemoved).toMatchObject({ takenDown: 0 });
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
    // Resale listings survive their creator archiving an item; a takedown is the
    // case where they must not, so the rows go with it.
    expect(mocks.resaleDeleteMany).toHaveBeenCalledWith({ where: { shopItemId: 42 } });

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

  // Payouts are written under the purchase prefix (`<prefix>:sell:...`), so the buyer's prefix
  // refund can already have reversed them. Refunding one again by id asks the creator for it twice.
  it('does not refund a payout the prefix refund already reversed', async () => {
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
    mocks.refundMultiAccountTransaction.mockResolvedValue({
      refundedTransactions: [
        {
          originalTransactionId: 'buyer-debit',
          refundTransactionId: 'r-1',
          accountType: 'yellow',
          amount: 1000,
          originalExternalTransactionId: 'purchase-1-yellow',
        },
        {
          originalTransactionId: 'sell-tx-creator',
          refundTransactionId: 'r-2',
          accountType: 'yellow',
          amount: 500,
          originalExternalTransactionId: 'purchase-1:sell:11:yellow',
        },
      ],
      totalRefunded: 1500,
      externalTransactionIdPrefix: 'purchase-1',
    });

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    expect(mocks.refundTransaction.mock.calls).toEqual([
      ['sell-tx-reseller', expect.stringContaining('Cosmetic removed')],
    ]);
    expect(result).toMatchObject({ owedBack: 700, clawedBack: 700, failures: [] });
  });

  it('claws nothing back from a creator who bought their own sticker and was paid nothing', async () => {
    mocks.purchaseFindMany.mockResolvedValue([
      {
        userId: 11,
        buzzTransactionId: 'restock-1',
        unitAmount: 1000,
        meta: { payouts: [], platformCut: 1000 },
      },
    ]);

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    expect(mocks.refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'restock-1' })
    );
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ refunded: 1, owedBack: 0, clawedBack: 0, failures: [] });
  });

  it('still reports the reseller share of an unrecorded creator restock as unrecovered', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      ...shopItemRow,
      meta: { ...shopItemRow.meta, sellableByOthers: true, sellerShare: 20 },
    });
    mocks.purchaseFindMany.mockResolvedValue([
      { userId: 11, buzzTransactionId: 'restock-3', unitAmount: 1000, meta: null },
    ]);

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ owedBack: 0, unrecoveredResellerShare: 200 });
  });

  it('claws nothing back from a creator restock whose payout record never landed', async () => {
    mocks.purchaseFindMany.mockResolvedValue([
      { userId: 11, buzzTransactionId: 'restock-2', unitAmount: 1000, meta: null },
    ]);

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    expect(mocks.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ refunded: 1, owedBack: 0, clawedBack: 0, failures: [] });
  });

  // A withdrawn-item refund that began on a purchase may have reversed some of its legs, and the
  // prefix refund is refused whole over those: that run finishes it, not this one.
  it('leaves a purchase a withdrawn-item refund has begun to that refund', async () => {
    mocks.purchaseFindMany.mockResolvedValue([
      {
        ...purchases[0],
        meta: { withdrawnRefund: { trigger: 'archive', clawback: true, userId: 11, at: 'then' } },
      },
      purchases[1],
    ]);

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(mocks.refundMultiAccountTransaction.mock.calls).toEqual([
      [expect.objectContaining({ externalTransactionIdPrefix: 'purchase-2' })],
    ]);
    expect(result).toMatchObject({ refunded: 1, failures: [] });
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

describe('takedownCosmeticShopItem against a moderator refund of the same item', () => {
  type Row = {
    userId: number;
    shopItemId: number;
    buzzTransactionId: string;
    unitAmount: number;
    refunded: boolean;
    meta: Record<string, unknown> | null;
  };
  let itemMeta: Record<string, unknown>;
  let rows: Row[];
  const reversed = new Set<string>();

  const ledgerRows = [
    {
      transactionId: 'purchase-1-debit',
      externalTransactionId: 'purchase-1-yellow',
      accountId: 101,
      amount: 1000,
    },
    {
      transactionId: 'purchase-1-payout',
      externalTransactionId: 'purchase-1:sell:11:yellow',
      accountId: 0,
      amount: 700,
    },
  ];

  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    lockState.held.clear();
    lockState.onWait = undefined;
    lockState.exhausted = false;
    lockState.calls = [];
    reversed.clear();
    itemMeta = { purchases: 1 };
    rows = [
      {
        userId: 101,
        shopItemId: 42,
        buzzTransactionId: 'purchase-1',
        unitAmount: 1000,
        refunded: false,
        meta: {
          payouts: [
            { userId: 11, amount: 700, color: 'yellow', transactionId: 'purchase-1-payout' },
          ],
        },
      },
    ];

    mocks.shopItemFindUnique.mockImplementation(async () => ({ ...shopItemRow, meta: itemMeta }));
    mocks.shopItemUpdate.mockImplementation(
      async ({ data }: { data: { meta: Record<string, unknown> } }) => {
        itemMeta = data.meta;
        return { id: 42, ...data };
      }
    );
    mocks.purchaseFindMany.mockImplementation(
      async ({
        where,
      }: {
        where: { shopItemId?: number; refunded?: boolean; buzzTransactionId?: { in: string[] } };
      }) =>
        rows
          .filter(
            (r) =>
              (where.shopItemId === undefined || r.shopItemId === where.shopItemId) &&
              (where.refunded === undefined || r.refunded === where.refunded) &&
              (where.buzzTransactionId === undefined ||
                where.buzzTransactionId.in.includes(r.buzzTransactionId))
          )
          .map((r) => ({ ...r }))
    );
    mocks.purchaseUpdate.mockImplementation(
      async ({ where, data }: { where: { buzzTransactionId: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.buzzTransactionId === where.buzzTransactionId)!;
        Object.assign(row, data);
        return row;
      }
    );
    dbMock.dbWrite.userCosmeticShopPurchases.updateMany.mockImplementation(
      async ({ where }: { where: { buzzTransactionId: string; refunded: boolean } }) => {
        const row = rows.find(
          (r) => r.buzzTransactionId === where.buzzTransactionId && r.refunded === where.refunded
        );
        if (row) row.refunded = true;
        return { count: row ? 1 : 0 };
      }
    );
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);

    // The ledger: a leg is refunded once; the takedown's prefix refund is refused whole if any
    // leg already was, as the Buzz service does.
    mocks.getMultiAccountTransactionsByPrefix.mockImplementation(async (prefix: string) =>
      prefix === 'purchase-1' ? ledgerRows : []
    );
    mocks.getTransactionByExternalId.mockImplementation(async (externalId: string) =>
      reversed.has(externalId.replace(/^refund-/, '')) ? { amount: 1 } : null
    );
    mocks.refundTransaction.mockImplementation(async (transactionId: string) => {
      if (reversed.has(transactionId)) throw new Error('duplicate refund');
      reversed.add(transactionId);
      return { transactionId: `refund-${transactionId}` };
    });
    mocks.refundMultiAccountTransaction.mockImplementation(async () => {
      if (ledgerRows.some((l) => reversed.has(l.transactionId))) throw new Error('409 Conflict');
      ledgerRows.forEach((l) => reversed.add(l.transactionId));
      return {
        refundedTransactions: ledgerRows.map((l) => ({
          originalTransactionId: l.transactionId,
          refundTransactionId: `refund-${l.transactionId}`,
          accountType: 'yellow',
          amount: l.amount,
          originalExternalTransactionId: l.externalTransactionId,
        })),
        totalRefunded: 1700,
        externalTransactionIdPrefix: 'purchase-1',
      };
    });

    mocks.userCosmeticFindMany.mockResolvedValue([]);
    mocks.userFindUnique.mockResolvedValue({ settings: {} });
    mocks.resaleFindMany.mockResolvedValue([]);
    mocks.shopItemFindFirst.mockResolvedValue(null);
    mocks.packMemberFindMany.mockResolvedValue([]);
    mocks.shopItemUpdateMany.mockResolvedValue({ count: 0 });
    mocks.logToAxiom.mockResolvedValue(undefined);
    mocks.createNotification.mockResolvedValue(undefined);
    mocks.revokeCosmeticsFromUsers.mockResolvedValue({ revoked: 1 });
    mocks.removePlacementsByCosmetic.mockResolvedValue({
      considered: 0,
      settled: 0,
      failed: [],
      takenDown: 0,
      hasMore: false,
    });
  });

  // The takedown lands as the moderator call stamps the purchase. Before the stamp commits, the
  // takedown either reaches its own read of the purchases (no lock: the race) or is queued behind
  // the refund lock; `landed` fires on whichever comes first.
  it('waits for the refund that holds the lock, so one run refunds the purchase', async () => {
    let takedown: ReturnType<typeof takedownCosmeticShopItem> | undefined;
    const stamp = mocks.purchaseUpdate.getMockImplementation()!;
    mocks.purchaseUpdate.mockImplementation(async (args) => {
      if (!takedown && args.data.meta?.withdrawnRefund) {
        let landed!: () => void;
        const reachedOrQueued = new Promise<void>((resolve) => (landed = resolve));
        lockState.onWait = () => landed();
        const read = mocks.purchaseFindMany.getMockImplementation()!;
        mocks.purchaseFindMany.mockImplementation(async (findArgs) => {
          if (findArgs.where.shopItemId !== undefined) landed();
          return read(findArgs);
        });
        takedown = takedownCosmeticShopItem({ id: 42, reason: 'tos', moderatorId: 999 });
        // Or a takedown that gave up, so a broken lock fails the test instead of hanging it.
        takedown.catch(() => undefined).finally(landed);
        await reachedOrQueued;
      }
      return stamp(args);
    });

    const manual = await refundShopPurchases({
      buzzTransactionIds: ['purchase-1'],
      clawback: false,
      reason: 'chargeback',
      dryRun: false,
      moderatorId: 998,
    });
    const takenDown = await takedown!;

    // The moderator's refund finished on its own terms before the takedown began; the takedown
    // then found nothing left to refund.
    expect(manual.results[0]).toMatchObject({ status: 'refunded', clawedBack: 0 });
    expect(mocks.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mocks.refundTransaction.mock.calls.map(([id]) => id)).toEqual(['purchase-1-debit']);
    expect(takenDown.purchases).toBe(0);
    expect(mocks.logToAxiom.mock.calls.map(([entry]) => entry.message)).not.toContain(
      'Buyer refund failed'
    );
    // One lock for both, which the moderator call never waits on and the takedown does.
    expect(lockState.calls).toEqual([
      { key: 'creator-shop-withdrawn-refund:42', ttl: 60, autoRenew: true, maxRetries: 0 },
      {
        key: 'creator-shop-withdrawn-refund:42',
        ttl: 60,
        autoRenew: true,
        retryDelay: 500,
        maxRetries: 60,
      },
    ]);
  });

  it('changes nothing when the refund lock never frees, so it can be taken down again', async () => {
    lockState.held.set('creator-shop-withdrawn-refund:42', new Promise(() => undefined));
    lockState.exhausted = true;

    await expect(
      takedownCosmeticShopItem({ id: 42, reason: 'tos', moderatorId: 999 })
    ).rejects.toThrow(/Nothing was changed/);
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
    expect(itemMeta.takedown).toBeUndefined();
    expect(mocks.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mocks.revokeCosmeticsFromUsers).not.toHaveBeenCalled();
    expect(rows[0].refunded).toBe(false);
  });
});
