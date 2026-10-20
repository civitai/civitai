import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ErrorHandling from '~/server/utils/errorHandling';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { PGlite } from '@electric-sql/pglite';
import { NotificationCategory } from '~/server/common/enums';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

type Row = {
  transactionId: string;
  externalTransactionId: string;
  accountType: string;
  accountId: number;
  amount: number;
};

// The Buzz service records a refund as `refund-<transactionId>` and refuses a second one, so a
// double refund shows up here as a thrown error AND as a second call, not as silent success.
const ledger = vi.hoisted(() => ({
  rows: new Map<string, Row[]>(),
  refunded: new Set<string>(),
  failNext: new Set<string>(),
}));
const mocks = vi.hoisted(() => ({
  refundTransaction: vi.fn(),
  revokeCosmeticsFromUsers: vi.fn(),
  createNotification: vi.fn(),
}));
const locks = vi.hoisted(() => ({ held: new Set<string>() }));

vi.mock('~/server/services/buzz.service', () => ({
  getMultiAccountTransactionsByPrefix: async (prefix: string) => ledger.rows.get(prefix) ?? [],
  getTransactionByExternalId: async (externalId: string) =>
    ledger.refunded.has(externalId.replace(/^refund-/, '')) ? { amount: 1 } : null,
  refundTransaction: mocks.refundTransaction,
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({
  revokeCosmeticsFromUsers: mocks.revokeCosmeticsFromUsers,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mocks.createNotification,
}));
// A real mutex: a pass-through would let two runs refund side by side and hide a double refund.
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async (options: { key: string }, operation: () => Promise<unknown>) => {
    if (locks.held.has(options.key)) return null;
    locks.held.add(options.key);
    try {
      return await operation();
    } finally {
      locks.held.delete(options.key);
    }
  },
}));
vi.mock('~/server/utils/errorHandling', async (importOriginal) => {
  const actual = await importOriginal<typeof ErrorHandling>();
  return {
    ...actual,
    withRetries: (fn: () => Promise<unknown>, retries = 3) => actual.withRetries(fn, retries, 0),
  };
});

const { refundWithdrawnShopItem, sweepWithdrawnShopRefunds } = await import(
  '../creator-shop-withdrawn-refund.service'
);

const ITEM = 42;
const COSMETIC = 7;
const CREATOR = 11;
const MOD = 99;
const MARKED_AT = '2026-10-19T12:00:00.000Z';

type Purchase = {
  userId: number;
  buzzTransactionId: string;
  unitAmount: number;
  purchasedAt: Date;
  refunded: boolean;
  meta?: Record<string, unknown> | null;
};
let purchases: Purchase[];
let itemMeta: Record<string, unknown>;

const marker = (trigger: 'reject' | 'archive') => ({
  trigger,
  clawback: trigger === 'reject',
  userId: MOD,
  at: MARKED_AT,
});

/** A sale since payouts were recorded: one buyer debit and one creator payout under the prefix. */
const sale = (userId: number, P: string, amount = 1000, day = 10): Purchase => {
  ledger.rows.set(P, [
    {
      transactionId: `${P}-debit`,
      externalTransactionId: `${P}-yellow`,
      accountType: 'yellow',
      accountId: userId,
      amount,
    },
    {
      transactionId: `${P}-payout`,
      externalTransactionId: `${P}:sell:${CREATOR}:yellow`,
      accountType: 'yellow',
      accountId: 0,
      amount: amount * 0.7,
    },
  ]);
  return {
    userId,
    buzzTransactionId: P,
    unitAmount: amount,
    purchasedAt: new Date(`2026-10-${day}T00:00:00.000Z`),
    refunded: false,
  };
};

beforeEach(() => {
  ledger.rows.clear();
  ledger.refunded.clear();
  ledger.failNext.clear();
  locks.held.clear();
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.refundTransaction.mockImplementation(async (transactionId: string) => {
    // Yield, so concurrent runs interleave here rather than one finishing first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (ledger.failNext.delete(transactionId)) throw new Error('buzz 503');
    if (ledger.refunded.has(transactionId)) throw new Error('duplicate refund');
    ledger.refunded.add(transactionId);
    return { transactionId: `refund-${transactionId}` };
  });
  mocks.revokeCosmeticsFromUsers.mockImplementation(async ({ userIds }: { userIds: number[] }) => ({
    revoked: userIds.length,
  }));
  mocks.createNotification.mockResolvedValue(undefined);
  loggingMock.logToAxiom.mockResolvedValue(undefined);

  itemMeta = { purchases: 0, withdrawnRefund: marker('reject') };
  purchases = [sale(101, 'p-1'), sale(102, 'p-2')];

  const item = () => ({
    id: ITEM,
    title: 'Gilded Aurora',
    cosmeticId: COSMETIC,
    addedById: CREATOR,
    status: 'Rejected',
    meta: itemMeta,
    cosmetic: { createdById: CREATOR },
  });
  dbMock.dbWrite.cosmeticShopItem.findUnique.mockReset().mockImplementation(async () => item());
  dbMock.dbWrite.cosmeticShopItem.update
    .mockReset()
    .mockImplementation(async ({ data }: { data: { meta: Record<string, unknown> } }) => {
      itemMeta = data.meta;
      return item();
    });
  // The history append is one SQL statement whose values are the new entries and the cap; it
  // touches only `history`, so this applies it to the meta as it stands NOW.
  dbMock.dbWrite.$executeRaw
    .mockReset()
    .mockImplementation(async (_sql: TemplateStringsArray, entries: string, cap: number) => {
      const history = [...((itemMeta.history as unknown[]) ?? []), ...JSON.parse(entries)];
      itemMeta = { ...itemMeta, history: history.slice(-cap) };
      return 1;
    });
  dbMock.dbWrite.userCosmeticShopPurchases.findMany
    .mockReset()
    .mockImplementation(
      async ({
        where,
        orderBy,
      }: {
        where: { refunded: boolean; userId?: { not: number } };
        orderBy?: { purchasedAt: 'asc' };
      }) => {
        const rows = purchases
          .filter(
            (p) =>
              p.refunded === where.refunded &&
              (where.userId === undefined || p.userId !== where.userId.not)
          )
          .map((p) => ({ ...p, meta: p.meta ?? null }));
        if (orderBy) rows.sort((a, b) => a.purchasedAt.getTime() - b.purchasedAt.getTime());
        return rows;
      }
    );
  dbMock.dbWrite.userCosmeticShopPurchases.update
    .mockReset()
    .mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { buzzTransactionId: string };
        data: { meta: Record<string, unknown> };
      }) => {
        const row = purchases.find((p) => p.buzzTransactionId === where.buzzTransactionId)!;
        row.meta = data.meta;
        return row;
      }
    );
  dbMock.dbWrite.userCosmeticShopPurchases.updateMany
    .mockReset()
    .mockImplementation(
      async ({ where }: { where: { buzzTransactionId: string; refunded: boolean } }) => {
        const row = purchases.find(
          (p) => p.buzzTransactionId === where.buzzTransactionId && p.refunded === where.refunded
        );
        if (row) row.refunded = true;
        return { count: row ? 1 : 0 };
      }
    );
});

const refundedIds = () => mocks.refundTransaction.mock.calls.map(([id]) => id).sort();

describe('refundWithdrawnShopItem after a rejection', () => {
  it('refunds every buyer, reverses the creator payouts and takes the cosmetic back', async () => {
    const result = await refundWithdrawnShopItem(ITEM);

    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout', 'p-2-debit', 'p-2-payout']);
    expect(purchases.map((p) => p.refunded)).toEqual([true, true]);
    // One revoke per purchase, each scoped to that purchase's own grant.
    expect(mocks.revokeCosmeticsFromUsers.mock.calls).toEqual([
      [{ userIds: [101], cosmeticIds: [COSMETIC], claimKeys: ['p-1'] }],
      [{ userIds: [102], cosmeticIds: [COSMETIC], claimKeys: ['p-2'] }],
    ]);
    expect(mocks.createNotification.mock.calls).toEqual([
      [
        {
          type: 'cosmetic-shop-item-refunded',
          userId: 101,
          category: NotificationCategory.System,
          key: `cosmetic-shop-item-refunded:${ITEM}:101`,
          details: { title: 'Gilded Aurora' },
        },
      ],
      [
        {
          type: 'cosmetic-shop-item-refunded',
          userId: 102,
          category: NotificationCategory.System,
          key: `cosmetic-shop-item-refunded:${ITEM}:102`,
          details: { title: 'Gilded Aurora' },
        },
      ],
    ]);
    expect(result).toEqual({ purchases: 2, refunded: 2, failures: 0 });
  });

  it('takes the cosmetic back before marking the purchase, so a run that dies between is retried', async () => {
    const order: string[] = [];
    mocks.revokeCosmeticsFromUsers.mockImplementation(async ({ claimKeys }) => {
      order.push(`revoke ${claimKeys[0]}`);
      return { revoked: 1 };
    });
    const mark = dbMock.dbWrite.userCosmeticShopPurchases.updateMany.getMockImplementation()!;
    dbMock.dbWrite.userCosmeticShopPurchases.updateMany.mockImplementation(async (args) => {
      order.push(`mark ${args.where.buzzTransactionId}`);
      return mark(args);
    });

    await refundWithdrawnShopItem(ITEM);

    expect(order).toEqual(['revoke p-1', 'mark p-1', 'revoke p-2', 'mark p-2']);
  });

  it('a notification that fails does not undo or stop the rest', async () => {
    mocks.createNotification.mockRejectedValue(new Error('notifications down'));

    const result = await refundWithdrawnShopItem(ITEM);

    expect(result).toEqual({ purchases: 2, refunded: 2, failures: 0 });
    expect((itemMeta.history as { kind: string }[]).at(-1)).toMatchObject({ kind: 'refunded' });
  });

  it('takes at most `limit` purchases, oldest first, and leaves the rest owed', async () => {
    purchases = [sale(101, 'p-new', 1000, 12), sale(102, 'p-old', 1000, 11)];

    const result = await refundWithdrawnShopItem(ITEM, { limit: 1 });

    expect(result).toEqual({ purchases: 1, refunded: 1, failures: 0 });
    expect(refundedIds()).toEqual(['p-old-debit', 'p-old-payout']);
    expect(purchases.map((p) => p.refunded)).toEqual([false, true]);
  });

  it('records the refund on the item history and in Axiom', async () => {
    await refundWithdrawnShopItem(ITEM);

    expect((itemMeta.history as { kind: string; note: string }[]).at(-1)).toMatchObject({
      kind: 'refunded',
      userId: MOD,
      note: '2 purchase(s), 2000 Buzz refunded; 1400 Buzz reversed from payouts',
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'creator-shop-withdrawn-refund',
        message: 'Withdrawn refund finished',
        data: expect.objectContaining({ refunded: 2, refundedValue: 2000, clawedBack: 1400 }),
      })
    );
  });

  it("leaves out the creator's own purchase and anything bought after the verdict", async () => {
    purchases = [sale(CREATOR, 'own'), sale(101, 'p-1'), sale(102, 'late', 1000, 20)];

    await refundWithdrawnShopItem(ITEM);

    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout']);
    expect(purchases.map((p) => p.refunded)).toEqual([false, true, false]);
  });
});

describe('refundWithdrawnShopItem after archiving a withheld item', () => {
  it('refunds the buyers and leaves the creator paid', async () => {
    itemMeta = { purchases: 0, withdrawnRefund: marker('archive') };

    await refundWithdrawnShopItem(ITEM);

    expect(refundedIds()).toEqual(['p-1-debit', 'p-2-debit']);
    expect(purchases.map((p) => p.refunded)).toEqual([true, true]);
  });

  describe('when the creator pays', () => {
    beforeEach(() => {
      itemMeta = { purchases: 0, withdrawnRefund: { ...marker('archive'), clawback: true } };
    });

    it('takes the payout back before refunding the buyer', async () => {
      await refundWithdrawnShopItem(ITEM);

      expect(mocks.refundTransaction.mock.calls.map(([id]) => id)).toEqual([
        'p-1-payout',
        'p-1-debit',
        'p-2-payout',
        'p-2-debit',
      ]);
    });

    // An archive is the creator's own act: a payout they've already spent must not leave the
    // platform refunding their buyers for them.
    it('refunds nobody whose payout will not come back, and leaves the purchase owed', async () => {
      mocks.refundTransaction.mockImplementation(async (transactionId: string) => {
        if (transactionId === 'p-1-payout') throw new Error('insufficient funds');
        ledger.refunded.add(transactionId);
      });

      const result = await refundWithdrawnShopItem(ITEM);

      expect(result).toEqual({ purchases: 2, refunded: 1, failures: 1 });
      expect(ledger.refunded.has('p-1-debit')).toBe(false);
      expect(purchases.map((p) => p.refunded)).toEqual([false, true]);
      expect(mocks.revokeCosmeticsFromUsers.mock.calls.map(([a]) => a.claimKeys)).toEqual([
        ['p-2'],
      ]);
    });
  });
});

describe('refundWithdrawnShopItem and a verdict landing mid-run', () => {
  it('stops at the next purchase once the marker is cleared', async () => {
    mocks.revokeCosmeticsFromUsers.mockImplementation(async () => {
      // An approval lands while the first purchase is being settled.
      const { withdrawnRefund: _cleared, ...rest } = itemMeta;
      itemMeta = { ...rest, displayApproved: true };
      return { revoked: 1 };
    });

    const result = await refundWithdrawnShopItem(ITEM);

    expect(result).toEqual({ purchases: 2, refunded: 1, failures: 0 });
    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout']);
    expect(purchases.map((p) => p.refunded)).toEqual([true, false]);
  });

  it('records the refund without bringing back what the verdict cleared', async () => {
    mocks.revokeCosmeticsFromUsers.mockImplementation(async () => {
      const { withdrawnRefund: _cleared, ...rest } = itemMeta;
      itemMeta = { ...rest, displayApproved: true };
      return { revoked: 1 };
    });

    await refundWithdrawnShopItem(ITEM);

    expect(itemMeta.withdrawnRefund).toBeUndefined();
    expect(itemMeta.displayApproved).toBe(true);
    expect((itemMeta.history as { kind: string }[]).at(-1)).toMatchObject({ kind: 'refunded' });
    expect(dbMock.dbWrite.cosmeticShopItem.update).not.toHaveBeenCalled();
  });
});

describe('refundWithdrawnShopItem and a purchase already begun', () => {
  // Some of a purchase's legs reversed and the rest not: stopping there strands money on both
  // sides, so a begun purchase is finished on the terms it began under.
  it('finishes a purchase begun under a marker that has since been cleared', async () => {
    itemMeta = { purchases: 0, withdrawnRefund: { ...marker('archive'), clawback: true } };
    mocks.refundTransaction.mockImplementation(async (transactionId: string) => {
      if (transactionId === 'p-1-debit') throw new Error('buzz 503');
      ledger.refunded.add(transactionId);
    });
    await refundWithdrawnShopItem(ITEM, { limit: 1 });
    expect(ledger.refunded.has('p-1-payout')).toBe(true);
    expect(purchases.map((p) => p.refunded)).toEqual([false, false]);

    // The creator restores the item, which clears the marker.
    const { withdrawnRefund: _cleared, ...rest } = itemMeta;
    itemMeta = rest;
    mocks.refundTransaction.mockReset().mockImplementation(async (transactionId: string) => {
      ledger.refunded.add(transactionId);
    });
    const result = await refundWithdrawnShopItem(ITEM);

    expect(mocks.refundTransaction.mock.calls.map(([id]) => id)).toEqual(['p-1-debit']);
    expect(result).toEqual({ purchases: 1, refunded: 1, failures: 0 });
    // The purchase never begun stays with its buyer.
    expect(purchases.map((p) => p.refunded)).toEqual([true, false]);
  });

  it('stamps the terms on a purchase before moving any of its money', async () => {
    const seen: unknown[] = [];
    mocks.refundTransaction.mockImplementation(async (transactionId: string) => {
      seen.push(purchases.find((p) => transactionId.startsWith(p.buzzTransactionId))?.meta);
      ledger.refunded.add(transactionId);
    });

    await refundWithdrawnShopItem(ITEM);

    expect(seen).toHaveLength(4);
    for (const meta of seen) expect(meta).toEqual({ withdrawnRefund: marker('reject') });
  });
});

describe('refundWithdrawnShopItem edge cases', () => {
  it('counts and notifies only purchases this run marked', async () => {
    const mark = dbMock.dbWrite.userCosmeticShopPurchases.updateMany.getMockImplementation()!;
    dbMock.dbWrite.userCosmeticShopPurchases.updateMany.mockImplementation(async (args) =>
      // Another path marked p-1 between this run's read and its write.
      args.where.buzzTransactionId === 'p-1' ? { count: 0 } : mark(args)
    );

    const result = await refundWithdrawnShopItem(ITEM);

    expect(result).toEqual({ purchases: 2, refunded: 1, failures: 0 });
    expect(mocks.createNotification.mock.calls.map(([n]) => n.userId)).toEqual([102]);
    expect((itemMeta.history as { note: string }[]).at(-1)!.note).toBe(
      '1 purchase(s), 1000 Buzz refunded; 700 Buzz reversed from payouts'
    );
  });

  it('marks a free purchase without asking Buzz to reverse a charge that never happened', async () => {
    const charge = '7d9e2b1c-0000-4000-8000-000000000001';
    purchases = [
      {
        userId: 101,
        buzzTransactionId: charge,
        unitAmount: 0,
        purchasedAt: new Date('2026-10-10T00:00:00.000Z'),
        refunded: false,
      },
    ];

    await refundWithdrawnShopItem(ITEM);

    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(purchases[0].refunded).toBe(true);
  });

  it('notifies a buyer with two purchases once', async () => {
    purchases = [sale(101, 'p-1'), sale(101, 'p-2')];

    await refundWithdrawnShopItem(ITEM);

    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    expect(purchases.map((p) => p.refunded)).toEqual([true, true]);
  });

  it('leaves a purchase owed when its ledger cannot be read', async () => {
    const charge = '7d9e2b1c-0000-4000-8000-000000000002';
    purchases = [
      {
        userId: 101,
        buzzTransactionId: charge,
        unitAmount: 1000,
        purchasedAt: new Date('2026-10-10T00:00:00.000Z'),
        refunded: false,
      },
    ];
    const list = vi.spyOn(ledger.rows, 'get').mockImplementation(() => {
      throw new Error('buzz 503');
    });

    const result = await refundWithdrawnShopItem(ITEM);
    list.mockRestore();

    // Read as an empty ledger, the legacy fallback would invent a debit and refund it.
    expect(result).toEqual({ purchases: 1, refunded: 0, failures: 1 });
    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(purchases[0].refunded).toBe(false);
  });
});

describe('refundWithdrawnShopItem refunds once', () => {
  it('two verdicts landing together refund each transaction once', async () => {
    const [a, b] = await Promise.all([
      refundWithdrawnShopItem(ITEM),
      refundWithdrawnShopItem(ITEM),
    ]);

    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout', 'p-2-debit', 'p-2-payout']);
    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    expect(mocks.revokeCosmeticsFromUsers).toHaveBeenCalledTimes(2);
    expect(mocks.createNotification).toHaveBeenCalledTimes(2);
  });

  it('a second run after the first finished refunds nothing', async () => {
    await refundWithdrawnShopItem(ITEM);
    mocks.refundTransaction.mockClear();
    mocks.revokeCosmeticsFromUsers.mockClear();

    expect(await refundWithdrawnShopItem(ITEM)).toEqual({ purchases: 0, refunded: 0, failures: 0 });
    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(mocks.revokeCosmeticsFromUsers).not.toHaveBeenCalled();
  });

  it('a retry after a failed buyer refund skips what already landed and finishes the rest', async () => {
    // Paid in two colours, the second debit failing every attempt: the buyer is still owed when
    // the run stops.
    ledger.rows.get('p-1')![0].amount = 600;
    ledger.rows.get('p-1')!.splice(1, 0, {
      transactionId: 'p-1-debit-blue',
      externalTransactionId: 'p-1-blue',
      accountType: 'blue',
      accountId: 101,
      amount: 400,
    });
    mocks.refundTransaction.mockImplementation(async (transactionId: string) => {
      if (transactionId === 'p-1-debit-blue') throw new Error('buzz 503');
      ledger.refunded.add(transactionId);
    });

    const first = await refundWithdrawnShopItem(ITEM);

    expect(first).toEqual({ purchases: 2, refunded: 1, failures: 1 });
    expect(purchases.map((p) => p.refunded)).toEqual([false, true]);
    // The payout is not touched before the buyer is whole, and nothing is taken from them.
    expect(ledger.refunded.has('p-1-payout')).toBe(false);
    expect(mocks.revokeCosmeticsFromUsers.mock.calls.map(([a]) => a.claimKeys)).toEqual([['p-2']]);

    mocks.refundTransaction.mockReset().mockImplementation(async (transactionId: string) => {
      ledger.refunded.add(transactionId);
    });
    const second = await refundWithdrawnShopItem(ITEM);

    expect(second).toEqual({ purchases: 1, refunded: 1, failures: 0 });
    expect(mocks.refundTransaction.mock.calls.map(([id]) => id)).toEqual([
      'p-1-debit-blue',
      'p-1-payout',
    ]);
  });

  it('a payout that will not come back settles the buyer and is logged for a person', async () => {
    mocks.refundTransaction.mockImplementation(async (transactionId: string) => {
      if (transactionId === 'p-1-payout') throw new Error('insufficient funds');
      ledger.refunded.add(transactionId);
    });

    const result = await refundWithdrawnShopItem(ITEM);

    expect(result).toEqual({ purchases: 2, refunded: 2, failures: 0 });
    expect(purchases.map((p) => p.refunded)).toEqual([true, true]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        message: 'Payout clawback failed',
        data: expect.objectContaining({
          buzzTransactionId: 'p-1',
          transactionId: 'p-1-payout',
          amount: 700,
        }),
      })
    );
    expect((itemMeta.history as { note: string }[]).at(-1)!.note).toBe(
      '2 purchase(s), 2000 Buzz refunded; 700 Buzz reversed from payouts'
    );
  });
});

describe('refundWithdrawnShopItem refuses what it was not written for', () => {
  it('stops a purchase with an unexpected transaction under its prefix', async () => {
    ledger.rows.get('p-1')!.push({
      transactionId: 'stray',
      externalTransactionId: 'p-1:tip',
      accountType: 'yellow',
      accountId: 5,
      amount: 10,
    });

    const result = await refundWithdrawnShopItem(ITEM);

    expect(refundedIds()).toEqual(['p-2-debit', 'p-2-payout']);
    expect(result).toEqual({ purchases: 2, refunded: 1, failures: 1 });
  });

  it('stops a purchase whose debits do not add up to the price', async () => {
    purchases[0].unitAmount = 1200;

    await refundWithdrawnShopItem(ITEM);

    expect(refundedIds()).toEqual(['p-2-debit', 'p-2-payout']);
  });

  it.each([
    ['no marker', { purchases: 0 }],
    [
      'a takedown',
      {
        purchases: 0,
        withdrawnRefund: { trigger: 'reject', clawback: true, userId: MOD, at: MARKED_AT },
        takedown: { reason: 'tos', moderatorId: MOD, at: MARKED_AT },
      },
    ],
  ])('does nothing for an item with %s', async (_, meta) => {
    itemMeta = meta;

    await refundWithdrawnShopItem(ITEM);

    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(purchases.map((p) => p.refunded)).toEqual([false, false]);
  });
});

describe('refundWithdrawnShopItem on a sale from before payouts were recorded', () => {
  it("refunds the buyer's charge and its payout by the charge's own id", async () => {
    const charge = '0f4bedbd-bc23-4ee0-a5f7-89d7b23f3c99';
    ledger.rows.set(charge, [
      {
        transactionId: 'legacy-payout',
        externalTransactionId: charge,
        accountType: 'yellow',
        accountId: 0,
        amount: 700,
      },
    ]);
    purchases = [
      {
        userId: 101,
        buzzTransactionId: charge,
        unitAmount: 1000,
        purchasedAt: new Date('2026-07-01T00:00:00.000Z'),
        refunded: false,
      },
    ];

    await refundWithdrawnShopItem(ITEM);

    expect(refundedIds()).toEqual([charge, 'legacy-payout']);
  });
});

describe('sweepWithdrawnShopRefunds', () => {
  it('runs the refund for every item the query returns', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ id: ITEM }]);

    const result = await sweepWithdrawnShopRefunds();

    expect(result).toEqual({ items: 1, refunded: 2, failures: 0, busy: 0 });
    expect(purchases.map((p) => p.refunded)).toEqual([true, true]);
  });
});

// The fake above applies the append in JS; this runs the real statement, so a wrong cap, order,
// path or WHERE shows up here.
describe('the history append, run against Postgres', () => {
  let db: PGlite;
  const OTHER_ITEM = 43;
  const stored = async (id: number) =>
    (
      await db.query<{ meta: Record<string, unknown> }>(
        'SELECT meta FROM "CosmeticShopItem" WHERE id = $1',
        [id]
      )
    ).rows[0].meta;
  const seed = async (id: number, meta: Record<string, unknown>) =>
    db.query('INSERT INTO "CosmeticShopItem" (id, meta) VALUES ($1, $2)', [
      id,
      JSON.stringify(meta),
    ]);
  const entry = (n: number) => ({ at: 'then', userId: CREATOR, kind: 'edited', note: String(n) });

  beforeEach(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE "CosmeticShopItem" (id int PRIMARY KEY, meta jsonb)');
    dbMock.dbWrite.$executeRaw.mockImplementation(pgliteRaw(db).executeRaw as never);
  });

  it('appends one entry and leaves every other key, and every other item, alone', async () => {
    const before = { ...itemMeta, displayApproved: false, history: [entry(0), entry(1)] };
    await seed(ITEM, before);
    await seed(OTHER_ITEM, { purchases: 3, history: [entry(9)] });

    await refundWithdrawnShopItem(ITEM);

    const after = await stored(ITEM);
    const { history, ...rest } = after;
    const { history: _old, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(history).toEqual([
      entry(0),
      entry(1),
      expect.objectContaining({ kind: 'refunded', userId: MOD }),
    ]);
    expect(await stored(OTHER_ITEM)).toEqual({ purchases: 3, history: [entry(9)] });
  });

  it('keeps the newest entries at the cap, dropping the oldest', async () => {
    await seed(ITEM, { ...itemMeta, history: Array.from({ length: 25 }, (_, i) => entry(i)) });

    await refundWithdrawnShopItem(ITEM);

    const { history } = (await stored(ITEM)) as { history: { note?: string; kind: string }[] };
    expect(history).toHaveLength(25);
    expect(history[0].note).toBe('1');
    expect(history.at(-2)!.note).toBe('24');
    expect(history.at(-1)!.kind).toBe('refunded');
  });

  it('starts a history on an item that has none', async () => {
    await seed(ITEM, { purchases: 0 });

    await refundWithdrawnShopItem(ITEM);

    expect(await stored(ITEM)).toEqual({
      purchases: 0,
      history: [expect.objectContaining({ kind: 'refunded' })],
    });
  });
});
