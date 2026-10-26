import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CreatorShopLabels from '~/server/services/creator-shop-labels.service';
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
vi.mock('~/server/services/creator-shop-labels.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorShopLabels>()),
  recordShopTakedownLabel: vi.fn(async () => undefined),
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
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
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
// meta: null = no payout record on the row (written before it existed, or its write failed).
const purchases = [
  { userId: 101, buzzTransactionId: 'purchase-1', unitAmount: 1000, meta: null },
  { userId: 102, buzzTransactionId: 'purchase-2', unitAmount: 1000, meta: null },
];

type LedgerRow = {
  transactionId: string;
  externalTransactionId: string;
  accountId: number;
  amount: number;
};
// The Buzz ledger under each purchase id. By default a sale is the buyer's yellow debit and the
// creator's 700 payout under `<P>:sell:`.
let ledger: Record<string, LedgerRow[]>;
const sale = (prefix: string, buyerId: number): LedgerRow[] => [
  {
    transactionId: `${prefix}-debit`,
    externalTransactionId: `${prefix}-yellow`,
    accountId: buyerId,
    amount: 1000,
  },
  {
    transactionId: `${prefix}-payout`,
    externalTransactionId: `${prefix}:sell:11:yellow`,
    accountId: 0,
    amount: 700,
  },
];
const refundedIds = () => mocks.refundTransaction.mock.calls.map(([id]: [string]) => id);

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
    ledger = Object.fromEntries(
      purchases.map((p) => [p.buzzTransactionId, sale(p.buzzTransactionId, p.userId)])
    );
    mocks.getMultiAccountTransactionsByPrefix.mockImplementation(
      async (prefix: string) => ledger[prefix] ?? []
    );
    mocks.getTransactionByExternalId.mockResolvedValue(null);
    mocks.refundTransaction.mockImplementation(async (transactionId: string) => ({
      transactionId: `refund-${transactionId}`,
    }));
    // As the Buzz service would: every leg under the prefix. Nothing here should call it.
    mocks.refundMultiAccountTransaction.mockImplementation(
      async ({ externalTransactionIdPrefix: prefix }: { externalTransactionIdPrefix: string }) => {
        const legs = ledger[prefix] ?? [];
        return {
          refundedTransactions: legs.map((l) => ({
            originalTransactionId: l.transactionId,
            refundTransactionId: `refund-${l.transactionId}`,
            accountType: 'yellow',
            amount: l.amount,
            originalExternalTransactionId: l.externalTransactionId,
          })),
          totalRefunded: legs.reduce((sum, l) => sum + l.amount, 0),
          externalTransactionIdPrefix: prefix,
        };
      }
    );
    mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'tx' });
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
    // Its event tags are placements too: left on, an item restored later would rejoin every
    // section with that tag.
    expect(update.data.eventTags).toEqual([]);
    // Resale listings survive their creator archiving an item; a takedown is the
    // case where they must not, so the rows go with it.
    expect(mocks.resaleDeleteMany).toHaveBeenCalledWith({ where: { shopItemId: 42 } });

    // Each leg refunded by its own id: the buyer first, then the payout.
    expect(refundedIds()).toEqual([
      'purchase-1-debit',
      'purchase-1-payout',
      'purchase-2-debit',
      'purchase-2-payout',
    ]);
    expect(mocks.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(mocks.purchaseUpdate).toHaveBeenCalledWith({
      where: { buzzTransactionId: 'purchase-1' },
      data: { refunded: true },
    });

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
      revokedFrom: 3,
      failures: [],
    });
  });

  it('records the takedown label once the archive is written and the buyers refunded', async () => {
    const { recordShopTakedownLabel } = await import(
      '~/server/services/creator-shop-labels.service'
    );
    vi.mocked(recordShopTakedownLabel).mockClear();
    const order: string[] = [];
    const update = mocks.shopItemUpdate.getMockImplementation();
    mocks.shopItemUpdate.mockImplementationOnce(async (...args: unknown[]) => {
      order.push('archive');
      return update?.(...args);
    });
    const refund = mocks.refundTransaction.getMockImplementation();
    mocks.refundTransaction.mockImplementation(async (...args: unknown[]) => {
      order.push('refund');
      return refund?.(...args);
    });
    mocks.createNotification.mockImplementation(async () => {
      order.push('notify');
    });
    vi.mocked(recordShopTakedownLabel).mockImplementationOnce(async () => {
      order.push('label');
    });

    await takedownCosmeticShopItem({ id: 42, reason: 'IP infringement', moderatorId: 999 });

    expect(order[0]).toBe('archive');
    expect(order).toContain('refund');
    // After the refund lock is released, which the creator notice is sent after.
    expect(order.slice(-2)).toEqual(['notify', 'label']);
    const archivedAt = mocks.shopItemUpdate.mock.calls[0][0].data.archivedAt as Date;
    expect(recordShopTakedownLabel).toHaveBeenCalledTimes(1);
    expect(recordShopTakedownLabel).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        moderatorId: 999,
        at: archivedAt.toISOString(),
        note: 'IP infringement',
        statusAfter: 'Archived',
      })
    );
  });

  it('finishes the takedown when its label cannot be recorded', async () => {
    const labels = await import('~/server/services/creator-shop-labels.service');
    const actual = await vi.importActual<typeof CreatorShopLabels>(
      '~/server/services/creator-shop-labels.service'
    );
    vi.mocked(labels.recordShopTakedownLabel).mockImplementationOnce(
      actual.recordShopTakedownLabel
    );
    // The first transaction archives the item under its row lock; the label's is the second.
    dbMock.dbWrite.$transaction
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(dbMock.dbWrite))
      .mockRejectedValueOnce(new Error('label transaction timed out'));

    const result = await takedownCosmeticShopItem({
      id: 42,
      reason: 'IP infringement',
      moderatorId: 999,
    });

    expect(mocks.shopItemUpdate.mock.calls[0][0].data.status).toBe('Archived');
    expect(mocks.refundTransaction).toHaveBeenCalled();
    expect(result.failures).toEqual([]);
    expect(mocks.logToAxiom).toHaveBeenCalledWith({
      type: 'error',
      name: 'shop-label-record-failed',
      itemId: 42,
    });
  });

  // The backfill labels each takedown history entry by its `at`; a retry's label must match its own entry.
  it('labels a retried takedown with the history entry the retry wrote', async () => {
    const { recordShopTakedownLabel } = await import(
      '~/server/services/creator-shop-labels.service'
    );
    vi.mocked(recordShopTakedownLabel).mockClear();
    mocks.shopItemFindUnique.mockResolvedValue({
      ...shopItemRow,
      status: 'Archived',
      meta: { takedown: { reason: 'IP infringement', moderatorId: 999, at: '2026-08-03' } },
    });

    await takedownCosmeticShopItem({ id: 42, reason: 'IP infringement', moderatorId: 999 });

    const { meta } = mocks.shopItemUpdate.mock.calls[0][0].data as {
      meta: CosmeticShopItemMeta;
    };
    const entry = meta.history!.at(-1)!;
    expect(recordShopTakedownLabel).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ at: entry.at, note: entry.note })
    );
    expect(entry.note).toBe('Retried: IP infringement');
  });

  // The archive builds meta from the row read under its lock; any earlier read may predate an
  // edit or a refund run's history entry, which writing that copy back would erase.
  it('keeps a history entry committed after the item was first read', async () => {
    const refunded = { at: '2026-08-03T00:00:00.000Z', userId: 999, kind: 'refunded' };
    let locked = false;
    dbMock.dbWrite.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: async (strings: TemplateStringsArray) => {
          if (strings.join('?').includes('FOR NO KEY UPDATE')) locked = true;
          return [];
        },
        cosmeticShopItem: {
          findUnique: async () => {
            if (!locked) throw new Error('read the row before locking it');
            return { ...shopItemRow, meta: { ...shopItemRow.meta, history: [refunded] } };
          },
          update: dbMock.dbWrite.cosmeticShopItem.update,
        },
      })
    );

    await takedownCosmeticShopItem({ id: 42, reason: 'IP infringement', moderatorId: 999 });

    const { meta } = mocks.shopItemUpdate.mock.calls[0][0].data as {
      meta: CosmeticShopItemMeta;
    };
    expect(meta.history?.map((e) => e.kind)).toEqual(['refunded', 'takedown']);
  });

  it('never refunds the creator submission fee', async () => {
    await takedownCosmeticShopItem({ id: 42, reason: 'TOS violation', moderatorId: 999 });

    expect(refundedIds()).not.toContain('fee-tx-1');
    expect(mocks.getMultiAccountTransactionsByPrefix).not.toHaveBeenCalledWith('fee-tx-1');
  });

  // A sale from before payouts were keyed under the purchase stored the buyer charge's own id, so
  // the ledger under it lists only the creator's payout: the charge itself is the buyer's leg.
  it('refunds the buyer of a legacy sale, not only the payout keyed by its charge id', async () => {
    const charge = 'a1b2c3d4-0000-4000-8000-000000000001';
    mocks.purchaseFindMany.mockResolvedValue([
      { userId: 101, buzzTransactionId: charge, unitAmount: 1000, meta: null },
    ]);
    ledger = {
      [charge]: [
        {
          transactionId: 'legacy-payout',
          externalTransactionId: charge,
          accountId: 0,
          amount: 700,
        },
      ],
    };

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    // The buyer's charge comes back, and the creator gives back the payout once, not again.
    expect(mocks.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(refundedIds()).toEqual([charge, 'legacy-payout']);
    expect(result).toMatchObject({
      refunded: 1,
      refundedValue: 1000,
      owedBack: 700,
      clawedBack: 700,
      failures: [],
    });
  });

  // A split legacy pool keyed each payout by the charge id and its recipient.
  it('reverses each recipient of a split legacy sale', async () => {
    const charge = 'a1b2c3d4-0000-4000-8000-000000000002';
    mocks.purchaseFindMany.mockResolvedValue([
      { userId: 101, buzzTransactionId: charge, unitAmount: 1000, meta: null },
    ]);
    ledger = {
      [charge]: [
        {
          transactionId: 'pay-11',
          externalTransactionId: `${charge}:11`,
          accountId: 0,
          amount: 500,
        },
        {
          transactionId: 'pay-55',
          externalTransactionId: `${charge}:55`,
          accountId: 0,
          amount: 200,
        },
      ],
    };

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(refundedIds()).toEqual([charge, 'pay-11', 'pay-55']);
    expect(result).toMatchObject({ refunded: 1, clawedBack: 700, failures: [] });
  });

  it('refunds a buyer who paid in two colours leg by leg', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    ledger = {
      'purchase-1': [
        {
          transactionId: 'd-blue',
          externalTransactionId: 'purchase-1-blue',
          accountId: 101,
          amount: 400,
        },
        {
          transactionId: 'd-green',
          externalTransactionId: 'purchase-1-green',
          accountId: 101,
          amount: 600,
        },
        {
          transactionId: 'p-blue',
          externalTransactionId: 'purchase-1:sell:11:blue',
          accountId: 0,
          amount: 280,
        },
        {
          transactionId: 'p-green',
          externalTransactionId: 'purchase-1:sell:11:green',
          accountId: 0,
          amount: 420,
        },
      ],
    };

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(refundedIds()).toEqual(['d-blue', 'd-green', 'p-blue', 'p-green']);
    expect(result).toMatchObject({ refundedValue: 1000, clawedBack: 700, failures: [] });
  });

  it('reverses every payout on the ledger, including a reseller cut', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    ledger = {
      'purchase-1': [
        sale('purchase-1', 101)[0],
        {
          transactionId: 'sell-tx-creator',
          externalTransactionId: 'purchase-1:sell:11:yellow',
          accountId: 0,
          amount: 500,
        },
        {
          transactionId: 'sell-tx-reseller',
          externalTransactionId: 'purchase-1:sell:55:yellow',
          accountId: 0,
          amount: 200,
        },
      ],
    };

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(refundedIds()).toEqual(['purchase-1-debit', 'sell-tx-creator', 'sell-tx-reseller']);
    expect(mocks.refundTransaction).toHaveBeenCalledWith(
      'sell-tx-reseller',
      expect.stringContaining('Cosmetic removed'),
      undefined
    );
    expect(result).toMatchObject({ owedBack: 700, clawedBack: 700, clawedBackPct: 70 });
  });

  // Run twice (a retry after a crash): a leg already refunded is not refunded again.
  it('does not refund a leg that already has its refund', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    mocks.getTransactionByExternalId.mockImplementation(async (externalId: string) =>
      externalId === 'refund-purchase-1-payout' ? { amount: 700 } : null
    );

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(refundedIds()).toEqual(['purchase-1-debit']);
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
    ledger = { 'restock-1': [sale('restock-1', 11)[0]] };

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(refundedIds()).toEqual(['restock-1-debit']);
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ refunded: 1, owedBack: 0, clawedBack: 0, failures: [] });
  });

  // The payouts landed but the row's payout record did not. The ledger is what was paid: each payout
  // comes back once, with no re-derived charge on top.
  it('reverses the payouts of a sale whose payout record never landed, once', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(refundedIds()).toEqual(['purchase-1-debit', 'purchase-1-payout']);
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ refunded: 1, owedBack: 700, clawedBack: 700, failures: [] });
  });

  // The control: no payout was ever made (the bank payout failed), so nothing is taken back.
  it('takes nothing back for a sale with no payout on the ledger', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    ledger = { 'purchase-1': [sale('purchase-1', 101)[0]] };

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(refundedIds()).toEqual(['purchase-1-debit']);
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ refunded: 1, owedBack: 0, clawedBack: 0, failures: [] });
  });

  // Deliberate: the ledger, not `meta.payouts`, is what was paid. A recorded payout without an id
  // used to become a fresh charge from the creator; reading the record again would bring that back.
  it('ignores the payout record and reverses the payout from the ledger, with no fresh charge', async () => {
    mocks.purchaseFindMany.mockResolvedValue([
      {
        ...purchases[0],
        meta: { payouts: [{ userId: 11, amount: 700, color: 'yellow' }], platformCut: 300 },
      },
    ]);

    await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(refundedIds()).toEqual(['purchase-1-debit', 'purchase-1-payout']);
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
  });

  it('leaves a purchase a withdrawn-item refund has begun to that refund', async () => {
    mocks.purchaseFindMany.mockResolvedValue([
      {
        ...purchases[0],
        meta: { withdrawnRefund: { trigger: 'archive', clawback: true, userId: 11, at: 'then' } },
      },
      purchases[1],
    ]);

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(refundedIds()).toEqual(['purchase-2-debit', 'purchase-2-payout']);
    expect(result).toMatchObject({ refunded: 1, failures: [] });
  });

  it('leaves a buyer unrefunded, and says so, when the ledger does not add up to the price', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    ledger = { 'purchase-1': [{ ...sale('purchase-1', 101)[0], amount: 400 }] };

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(mocks.purchaseUpdate).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      {
        stage: 'refund',
        userId: 101,
        amount: 1000,
        error: 'debits 400 do not match the price 1000',
      },
    ]);
  });

  // Payouts keyed `<P>` or `<P>:<userId>` only exist for sales that stored the charge's own id (a
  // GUID). Under any other purchase id such a row is not known to be a payout, so nothing is
  // refunded from it: refunding a row on a guess is not undoable.
  it('refuses a bank row keyed by a non-legacy purchase id rather than refund it as a payout', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    ledger = {
      'purchase-1': [
        sale('purchase-1', 101)[0],
        {
          transactionId: 'bank-55',
          externalTransactionId: 'purchase-1:55',
          accountId: 0,
          amount: 200,
        },
      ],
    };

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      {
        stage: 'refund',
        userId: 101,
        amount: 1000,
        error: 'unexpected transactions under the purchase: 1',
      },
    ]);
  });

  it('retries a transient refund failure instead of writing the sale off', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    const refund = mocks.refundTransaction.getMockImplementation()!;
    mocks.refundTransaction.mockRejectedValueOnce(new Error('503 upstream'));
    mocks.refundTransaction.mockImplementation(refund);

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(refundedIds()).toEqual(['purchase-1-debit', 'purchase-1-debit', 'purchase-1-payout']);
    expect(result).toMatchObject({ refunded: 1, failures: [] });
  });

  it('logs a permanently failed refund to Axiom with the ids needed to finish it by hand', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    mocks.refundTransaction.mockRejectedValue(new Error('insufficient bank funds'));

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    // Initial attempt + 3 retries before it's written off, and the payout is left alone.
    expect(refundedIds()).toEqual(Array(4).fill('purchase-1-debit'));
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
    const refund = mocks.refundTransaction.getMockImplementation()!;
    mocks.refundTransaction.mockImplementation(async (id: string, ...rest: unknown[]) => {
      if (id === 'purchase-1-debit') throw new Error('insufficient bank funds');
      return refund(id, ...rest);
    });

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(result.refunded).toBe(1);
    expect(result.failures).toEqual([
      { stage: 'refund', userId: 101, amount: 1000, error: 'insufficient bank funds' },
    ]);
    // Only the sale that was actually refunded is clawed back.
    expect(refundedIds()).not.toContain('purchase-1-payout');
    expect(refundedIds()).toContain('purchase-2-payout');
    expect(mocks.purchaseUpdate).toHaveBeenCalledTimes(1);
  });

  // The buyer's money is back; only the payout leg is left. Filing it as the buyer's full refund
  // would have a moderator pay the buyer a second time by hand.
  it('files a payout that will not come back as that payout, after refunding the buyer', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    ledger = {
      'purchase-1': [
        sale('purchase-1', 101)[0],
        {
          transactionId: 'sell-tx-creator',
          externalTransactionId: 'purchase-1:sell:11:yellow',
          accountId: 0,
          amount: 500,
        },
        {
          transactionId: 'sell-tx-reseller',
          externalTransactionId: 'purchase-1:sell:55:yellow',
          accountId: 0,
          amount: 200,
        },
      ],
    };
    const refund = mocks.refundTransaction.getMockImplementation()!;
    mocks.refundTransaction.mockImplementation(async (id: string, ...rest: unknown[]) => {
      if (id === 'sell-tx-reseller') throw new Error('insufficient funds');
      return refund(id, ...rest);
    });

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(result).toMatchObject({
      refunded: 1,
      refundedValue: 1000,
      clawedBack: 500,
      owedBack: 700,
    });
    expect(mocks.purchaseUpdate).toHaveBeenCalledWith({
      where: { buzzTransactionId: 'purchase-1' },
      data: { refunded: true },
    });
    expect(result.failures).toEqual([
      {
        stage: 'clawback',
        userId: 55,
        amount: 200,
        error: 'Payout sell-tx-reseller not reversed: insufficient funds',
      },
    ]);
    expect(mocks.revokeCosmeticsFromUsers).toHaveBeenCalled();
  });

  // A legacy single payout keyed by the charge id alone went to the creator, a reseller or a listed
  // payee, and the ledger does not say which. Naming the creator would bill someone on a guess.
  it('files a legacy payout that will not come back under its recipient, or under no one', async () => {
    const split = 'a1b2c3d4-0000-4000-8000-000000000003';
    const single = 'a1b2c3d4-0000-4000-8000-000000000004';
    mocks.purchaseFindMany.mockResolvedValue([
      { userId: 101, buzzTransactionId: split, unitAmount: 1000, meta: null },
      { userId: 102, buzzTransactionId: single, unitAmount: 1000, meta: null },
    ]);
    ledger = {
      [split]: [
        {
          transactionId: 'pay-55',
          externalTransactionId: `${split}:55`,
          accountId: 0,
          amount: 200,
        },
      ],
      [single]: [
        { transactionId: 'pay-any', externalTransactionId: single, accountId: 0, amount: 700 },
      ],
    };
    const refund = mocks.refundTransaction.getMockImplementation()!;
    mocks.refundTransaction.mockImplementation(async (id: string, ...rest: unknown[]) => {
      if (id.startsWith('pay-')) throw new Error('insufficient funds');
      return refund(id, ...rest);
    });

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(result).toMatchObject({
      refunded: 2,
      refundedValue: 2000,
      clawedBack: 0,
      owedBack: 900,
    });
    expect(result.failures).toEqual([
      {
        stage: 'clawback',
        userId: 55,
        amount: 200,
        error: 'Payout pay-55 not reversed: insufficient funds',
      },
      {
        stage: 'clawback',
        userId: 0,
        amount: 700,
        error: 'Payout pay-any not reversed (recipient not on its key): insufficient funds',
      },
    ]);
  });

  // The rest is back already; a hand refund of the full price would pay the first colour twice.
  it('files a buyer refund that stops partway at what is still owed', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchases[0]]);
    ledger = {
      'purchase-1': [
        {
          transactionId: 'd-blue',
          externalTransactionId: 'purchase-1-blue',
          accountId: 101,
          amount: 400,
        },
        {
          transactionId: 'd-green',
          externalTransactionId: 'purchase-1-green',
          accountId: 101,
          amount: 600,
        },
      ],
    };
    const refund = mocks.refundTransaction.getMockImplementation()!;
    mocks.refundTransaction.mockImplementation(async (id: string, ...rest: unknown[]) => {
      if (id === 'd-green') throw new Error('insufficient bank funds');
      return refund(id, ...rest);
    });

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(mocks.purchaseUpdate).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      { stage: 'refund', userId: 101, amount: 600, error: 'insufficient bank funds' },
    ]);
  });

  // Only a bank payout is a legacy payout: a buyer-owned row under the charge id is not known to
  // be anything, and refunding it on a guess cannot be undone.
  it('refuses a non-bank row under a legacy charge id rather than refund it', async () => {
    const charge = 'a1b2c3d4-0000-4000-8000-000000000005';
    mocks.purchaseFindMany.mockResolvedValue([
      { userId: 101, buzzTransactionId: charge, unitAmount: 1000, meta: null },
    ]);
    ledger = {
      [charge]: [
        { transactionId: 'odd', externalTransactionId: `${charge}:55`, accountId: 55, amount: 200 },
      ],
    };

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      {
        stage: 'refund',
        userId: 101,
        amount: 1000,
        error: 'unexpected transactions under the purchase: 1',
      },
    ]);
  });

  // Only `<P>` and `<P>:<id>` are legacy payout shapes. Another bank row starting with the charge id
  // is unknown and stops the purchase, like any unknown row.
  it('refuses a bank row that only starts with a legacy charge id', async () => {
    const charge = 'a1b2c3d4-0000-4000-8000-000000000006';
    mocks.purchaseFindMany.mockResolvedValue([
      { userId: 101, buzzTransactionId: charge, unitAmount: 1000, meta: null },
    ]);
    ledger = {
      [charge]: [
        { transactionId: 'fee', externalTransactionId: `${charge}-fee`, accountId: 0, amount: 50 },
      ],
    };

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      {
        stage: 'refund',
        userId: 101,
        amount: 1000,
        error: 'unexpected transactions under the purchase: 1',
      },
    ]);
  });

  // A pack's payouts go to each member's creator, keyed per member. All of them come back from
  // the ledger, so nothing is left for a moderator to settle and the lister is charged nothing.
  it('reverses every member payout of a pack sale and charges the lister nothing', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      ...shopItemRow,
      cosmeticId: null,
      cosmetic: null,
    });
    mocks.purchaseFindMany.mockResolvedValue([
      { userId: 101, buzzTransactionId: 'cosmetic-pack-1', unitAmount: 1000, meta: null },
    ]);
    ledger = {
      'cosmetic-pack-1': [
        sale('cosmetic-pack-1', 101)[0],
        {
          transactionId: 'pay-21',
          externalTransactionId: 'cosmetic-pack-1:sell:21:yellow:7',
          accountId: 0,
          amount: 300,
        },
        {
          transactionId: 'pay-22',
          externalTransactionId: 'cosmetic-pack-1:sell:22:yellow:8',
          accountId: 0,
          amount: 400,
        },
      ],
    };

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'IP', moderatorId: 999 });

    expect(refundedIds()).toEqual(['cosmetic-pack-1-debit', 'pay-21', 'pay-22']);
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ refunded: 1, owedBack: 700, clawedBack: 700, failures: [] });
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
    // The refund's history append: one statement adding to the meta as it stands now.
    dbMock.dbWrite.$executeRaw.mockImplementation(
      async (_sql: TemplateStringsArray, entries: string) => {
        const history = (itemMeta.history as unknown[]) ?? [];
        itemMeta = { ...itemMeta, history: [...history, ...JSON.parse(entries)] };
        return 1;
      }
    );

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
    // The refund's history entry survives the takedown's write of the item.
    expect((itemMeta.history as { kind: string }[]).map((e) => e.kind)).toEqual([
      'refunded',
      'takedown',
    ]);
  });

  it('still takes the item down, logged, when the refund lock cannot be had', async () => {
    lockState.held.set('creator-shop-withdrawn-refund:42', new Promise(() => undefined));
    lockState.exhausted = true;

    const result = await takedownCosmeticShopItem({ id: 42, reason: 'tos', moderatorId: 999 });

    expect(itemMeta.takedown).toMatchObject({ reason: 'tos' });
    expect(result.refunded).toBe(1);
    expect(mocks.refundTransaction.mock.calls.map(([id]) => id)).toEqual([
      'purchase-1-debit',
      'purchase-1-payout',
    ]);
    expect(mocks.logToAxiom.mock.calls.map(([entry]) => entry.message)).toContain(
      'Takedown ran without the refund lock'
    );
  });
});
