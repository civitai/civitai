import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ErrorHandling from '~/server/utils/errorHandling';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { BuzzApiError } from '@civitai/buzz';
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
const locks = vi.hoisted(() => ({ held: new Set<string>(), calls: [] as unknown[] }));

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
    locks.calls.push(options);
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

const { refundShopPurchases, refundWithdrawnShopItem, sweepWithdrawnShopRefunds } = await import(
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
  shopItemId?: number;
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
  locks.calls = [];
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
  // Any other id is a second live item with the same cosmetic and creator.
  dbMock.dbWrite.cosmeticShopItem.findUnique
    .mockReset()
    .mockImplementation(async ({ where }: { where: { id: number } }) =>
      where.id === ITEM ? item() : { ...item(), id: where.id, meta: { purchases: 0 } }
    );
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
  dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockReset().mockImplementation(
    async ({
      where,
      orderBy,
    }: {
      where: {
        refunded?: boolean;
        userId?: { not: number };
        buzzTransactionId?: { in: string[] };
      };
      orderBy?: { purchasedAt: 'asc' };
    }) => {
      const rows = purchases
        .filter(
          (p) =>
            (where.refunded === undefined || p.refunded === where.refunded) &&
            (where.userId === undefined || p.userId !== where.userId.not) &&
            (where.buzzTransactionId === undefined ||
              where.buzzTransactionId.in.includes(p.buzzTransactionId))
        )
        .map((p) => ({ ...p, shopItemId: p.shopItemId ?? ITEM, meta: p.meta ?? null }));
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

  // The key a takedown and a moderator's refund of the item also hold; the job never waits on it.
  it('runs under the item refund lock without waiting for it', async () => {
    await refundWithdrawnShopItem(ITEM);

    expect(locks.calls).toEqual([
      { key: `creator-shop-withdrawn-refund:${ITEM}`, ttl: 60, autoRenew: true, maxRetries: 0 },
    ]);
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
    // Recorded under the terms it began with, though the item no longer carries them.
    expect((itemMeta.history as { kind: string; userId: number }[]).at(-1)).toMatchObject({
      kind: 'refunded',
      userId: MOD,
    });
  });

  it('finishes a begun purchase on a taken-down item and leaves the rest to the takedown', async () => {
    itemMeta = {
      purchases: 0,
      withdrawnRefund: marker('reject'),
      takedown: { reason: 'tos', moderatorId: MOD, at: MARKED_AT },
    };
    purchases[0].meta = { withdrawnRefund: marker('reject') };

    const result = await refundWithdrawnShopItem(ITEM);

    expect(result).toEqual({ purchases: 1, refunded: 1, failures: 0 });
    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout']);
    expect(purchases.map((p) => p.refunded)).toEqual([true, false]);
  });

  it('reverses the payouts of a purchase stamped without clawback once the item is taken down', async () => {
    const noClawback = { ...marker('archive'), clawback: false };
    itemMeta = {
      purchases: 0,
      withdrawnRefund: noClawback,
      takedown: { reason: 'tos', moderatorId: MOD, at: MARKED_AT },
    };
    purchases[0].meta = { withdrawnRefund: noClawback };

    await refundWithdrawnShopItem(ITEM);

    expect(mocks.refundTransaction.mock.calls.map(([id]) => id)).toEqual([
      'p-1-debit',
      'p-1-payout',
    ]);
  });

  it('stops beginning purchases once a takedown lands mid-run', async () => {
    mocks.revokeCosmeticsFromUsers.mockImplementation(async () => {
      itemMeta = { ...itemMeta, takedown: { reason: 'tos', moderatorId: MOD, at: MARKED_AT } };
      return { revoked: 1 };
    });

    const result = await refundWithdrawnShopItem(ITEM);

    expect(result).toEqual({ purchases: 2, refunded: 1, failures: 0 });
    expect(purchases[1].meta ?? null).toBeNull();
  });

  it('keeps what the purchase row already recorded when it stamps the terms', async () => {
    const payouts = [
      { userId: CREATOR, amount: 700, color: 'yellow', transactionId: 'p-1-payout' },
    ];
    purchases[0].meta = { payouts, platformCut: 300 };

    await refundWithdrawnShopItem(ITEM);

    expect(purchases[0].meta).toEqual({
      payouts,
      platformCut: 300,
      withdrawnRefund: marker('reject'),
    });
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

// Runs the sweep's own query, so which items it picks up is the statement's answer, not a fake's.
describe('sweepWithdrawnShopRefunds, run against Postgres', () => {
  let db: PGlite;
  const picked: number[] = [];

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE "Cosmetic" (id int PRIMARY KEY, "createdById" int);
      CREATE TABLE "CosmeticShopItem" (id int PRIMARY KEY, "cosmeticId" int, "addedById" int, meta jsonb);
      CREATE TABLE "UserCosmeticShopPurchases" (
        "buzzTransactionId" text PRIMARY KEY, "shopItemId" int, "userId" int,
        refunded boolean, "purchasedAt" timestamp(3), meta jsonb
      );
      INSERT INTO "Cosmetic" VALUES (7, ${CREATOR});
    `);
    dbMock.dbRead.$queryRaw.mockImplementation(pgliteRaw(db).queryRaw as never);
    // Each item the sweep picks up is read once; nothing else is needed to know which.
    picked.length = 0;
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockImplementation(
      async ({ where }: { where: { id: number } }) => {
        picked.push(where.id);
        return null;
      }
    );
  });

  const item = (id: number, meta: Record<string, unknown>) =>
    db.query(`INSERT INTO "CosmeticShopItem" VALUES ($1, 7, ${CREATOR}, $2)`, [
      id,
      JSON.stringify(meta),
    ]);
  const purchase = (
    P: string,
    shopItemId: number,
    { userId = 101, refunded = false, day = 10, meta = null as unknown }
  ) =>
    db.query(`INSERT INTO "UserCosmeticShopPurchases" VALUES ($1, $2, $3, $4, $5, $6)`, [
      P,
      shopItemId,
      userId,
      refunded,
      `2026-10-${day}T00:00:00.000Z`,
      meta === null ? null : JSON.stringify(meta),
    ]);
  const stamped = { withdrawnRefund: marker('reject') };

  it('picks up what is owed, and only that', async () => {
    // Owed under the item's marker.
    await item(1, { withdrawnRefund: marker('reject') });
    await purchase('a', 1, {});
    // Marker cleared, one purchase begun under it: still owed.
    await item(2, { purchases: 0 });
    await purchase('b', 2, { meta: stamped });
    // Marker cleared, nothing begun: not owed.
    await item(3, { purchases: 0 });
    await purchase('c', 3, {});
    // Taken down, but one purchase already begun here: this path finishes it.
    await item(4, { withdrawnRefund: marker('reject'), takedown: { reason: 'r' } });
    await purchase('d', 4, { meta: stamped });
    // Taken down, nothing begun: the takedown settles it.
    await item(6, { withdrawnRefund: marker('reject'), takedown: { reason: 'r' } });
    await purchase('f', 6, {});
    // Bought after the verdict, the creator's own, or already refunded: not owed.
    await item(5, { withdrawnRefund: marker('reject') });
    await purchase('e1', 5, { day: 20 });
    await purchase('e2', 5, { userId: CREATOR });
    await purchase('e3', 5, { refunded: true });
    // The stamp stays on a purchase once it is finished; that is not owed either.
    await purchase('e4', 5, { refunded: true, meta: stamped });
    await purchase('e5', 5, { userId: CREATOR, meta: stamped });

    await sweepWithdrawnShopRefunds();

    expect(picked.sort()).toEqual([1, 2, 4]);
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

describe('money, as the ledger keeps it', () => {
  // The ledger exempts refunds from its own balance check, so reversing a payout the creator has
  // already spent takes them negative. This models exactly that and nothing more: the point is that
  // this code reverses every leg without a balance precondition of its own.
  it('leaves a creator who spent the payouts negative by exactly what was reversed', async () => {
    const balances = new Map<number, number>([
      [CREATOR, 0],
      [101, 0],
      [102, 0],
    ]);
    mocks.refundTransaction.mockImplementation(async (transactionId: string) => {
      const row = [...ledger.rows.values()].flat().find((r) => r.transactionId === transactionId)!;
      if (row.externalTransactionId.includes(':sell:'))
        balances.set(CREATOR, balances.get(CREATOR)! - row.amount);
      else balances.set(row.accountId, balances.get(row.accountId)! + row.amount);
      ledger.refunded.add(transactionId);
    });
    itemMeta = { purchases: 0, withdrawnRefund: { ...marker('archive'), clawback: true } };

    await refundWithdrawnShopItem(ITEM);

    expect(Object.fromEntries(balances)).toEqual({ [CREATOR]: -1400, 101: 1000, 102: 1000 });
  });
});

describe('each leg is refunded once', () => {
  it('skips a leg whose refund is already on the ledger', async () => {
    ledger.refunded.add('p-1-debit');
    ledger.refunded.add('p-1-payout');

    await refundWithdrawnShopItem(ITEM);

    expect(refundedIds()).toEqual(['p-2-debit', 'p-2-payout']);
    expect(purchases.map((p) => p.refunded)).toEqual([true, true]);
  });

  // A refund that landed but whose response was lost comes back as a 409 on the retry.
  it('counts a 409 as done when the refund is on the ledger, and as a failure when it is not', async () => {
    mocks.refundTransaction.mockImplementation(async (transactionId: string) => {
      if (transactionId === 'p-1-debit') {
        ledger.refunded.add(transactionId);
        throw new BuzzApiError(409, 'Conflict');
      }
      if (transactionId === 'p-2-debit') throw new BuzzApiError(409, 'Conflict');
      ledger.refunded.add(transactionId);
    });

    const result = await refundWithdrawnShopItem(ITEM);

    expect(result).toEqual({ purchases: 2, refunded: 1, failures: 1 });
    expect(purchases.map((p) => p.refunded)).toEqual([true, false]);
  });
});

describe('refundShopPurchases', () => {
  const refund = (
    buzzTransactionIds: string[],
    { clawback = true, dryRun = false }: { clawback?: boolean; dryRun?: boolean } = {}
  ) =>
    refundShopPurchases({
      buzzTransactionIds,
      clawback,
      dryRun,
      reason: 'chargeback',
      moderatorId: MOD,
    });

  const TAKEN_DOWN = 'the item was taken down; the takedown refunds its purchases';

  beforeEach(() => {
    itemMeta = { purchases: 0 };
    // An `onLedgerRead` hook that never fired must not reach the next test.
    delete (ledger.rows as { get?: unknown }).get;
  });

  it('a dry run reports what the real run would do with each purchase', async () => {
    purchases = [
      sale(101, 'p-1'),
      sale(102, 'p-2'),
      { ...sale(103, 'p-3'), refunded: true },
      sale(CREATOR, 'own'),
      { ...sale(104, 'free', 0), unitAmount: 0 },
    ];
    purchases[1].unitAmount = 1200;

    const result = await refund(['p-1', 'p-2', 'p-3', 'own', 'free'], {
      clawback: false,
      dryRun: true,
    });

    expect(
      result.results.map(({ buzzTransactionId, status, error, legs }) => ({
        buzzTransactionId,
        status,
        error,
        legs: legs?.map((l) => l.transactionId),
      }))
    ).toEqual([
      { buzzTransactionId: 'p-1', status: 'planned', error: undefined, legs: ['p-1-debit'] },
      {
        buzzTransactionId: 'p-2',
        status: 'failed',
        error: 'debits 1000 do not match the price 1200',
        legs: undefined,
      },
      {
        buzzTransactionId: 'p-3',
        status: 'skipped-already-refunded',
        error: undefined,
        legs: undefined,
      },
      {
        buzzTransactionId: 'own',
        status: 'failed',
        error: "the creator's own purchase is not a sale",
        legs: undefined,
      },
      { buzzTransactionId: 'free', status: 'planned', error: undefined, legs: [] },
    ]);
    expect(mocks.refundTransaction).not.toHaveBeenCalled();
  });

  it('a dry run refuses a taken-down item, as the real run does', async () => {
    itemMeta = { purchases: 0, takedown: { reason: 'tos', moderatorId: MOD, at: MARKED_AT } };

    const result = await refund(['p-1'], { dryRun: true });

    expect(result.results[0]).toMatchObject({ status: 'failed', error: TAKEN_DOWN });
  });

  it('a dry run moves nothing and lists the legs it would reverse', async () => {
    ledger.refunded.add('p-1-payout');

    const result = await refund(['p-1'], { dryRun: true });

    expect(result.results).toEqual([
      {
        buzzTransactionId: 'p-1',
        userId: 101,
        shopItemId: ITEM,
        status: 'planned',
        legs: [
          {
            kind: 'debit',
            transactionId: 'p-1-debit',
            accountId: 101,
            amount: 1000,
            alreadyRefunded: false,
          },
          {
            kind: 'payout',
            transactionId: 'p-1-payout',
            accountId: 0,
            amount: 700,
            alreadyRefunded: true,
          },
        ],
      },
    ]);
    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(mocks.revokeCosmeticsFromUsers).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.userCosmeticShopPurchases.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.userCosmeticShopPurchases.updateMany).not.toHaveBeenCalled();
    expect(purchases.map((p) => p.refunded)).toEqual([false, false]);
  });

  it('refunds only the named purchase, reverses its payout and takes the cosmetic back', async () => {
    const result = await refund(['p-1']);

    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout']);
    expect(purchases.map((p) => p.refunded)).toEqual([true, false]);
    expect(mocks.revokeCosmeticsFromUsers.mock.calls).toEqual([
      [{ userIds: [101], cosmeticIds: [COSMETIC], claimKeys: ['p-1'] }],
    ]);
    expect(result.totals).toEqual({
      planned: 0,
      refunded: 1,
      skipped: 0,
      failed: 0,
      refundedValue: 1000,
      clawedBack: 700,
    });
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cosmetic-shop-purchase-refunded', userId: 101 })
    );
    const entry = (itemMeta.history as { kind: string; userId: number; note: string }[]).at(-1)!;
    expect(entry).toMatchObject({ kind: 'refunded', userId: MOD });
    // The creator can read the history; the reason may describe the buyer.
    expect(entry.note).not.toContain('chargeback');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'creator-shop-purchase-refund',
        data: expect.objectContaining({ moderatorId: MOD, reason: 'chargeback' }),
      })
    );
  });

  it('leaves the creator paid without clawback', async () => {
    await refund(['p-1'], { clawback: false });

    expect(refundedIds()).toEqual(['p-1-debit']);
    expect(purchases[0].refunded).toBe(true);
  });

  it('refunds once when called twice', async () => {
    await refund(['p-1', 'p-2']);
    const again = await refund(['p-1', 'p-2']);

    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout', 'p-2-debit', 'p-2-payout']);
    expect(again.results.map((r) => r.status)).toEqual([
      'skipped-already-refunded',
      'skipped-already-refunded',
    ]);
  });

  it('reports each purchase on its own in a mixed call', async () => {
    purchases = [sale(CREATOR, 'own'), sale(101, 'p-1'), sale(102, 'p-2')];
    purchases[2].meta = { withdrawnRefund: { ...marker('reject'), clawback: false } };

    const result = await refund(['own', 'p-1', 'p-2', 'missing']);

    expect(
      result.results.map(({ buzzTransactionId, status, error }) => ({
        buzzTransactionId,
        status,
        error,
      }))
    ).toEqual([
      {
        buzzTransactionId: 'own',
        status: 'failed',
        error: "the creator's own purchase is not a sale",
      },
      { buzzTransactionId: 'p-1', status: 'refunded', error: undefined },
      {
        buzzTransactionId: 'p-2',
        status: 'failed',
        error: 'a refund already began with clawback false',
      },
      { buzzTransactionId: 'missing', status: 'failed', error: 'purchase not found' },
    ]);
    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout']);
  });

  it('refuses purchases on a taken-down item, which the takedown refunds', async () => {
    itemMeta = { purchases: 0, takedown: { reason: 'tos', moderatorId: MOD, at: MARKED_AT } };

    const result = await refund(['p-1']);

    expect(result.results[0]).toMatchObject({ status: 'failed', error: TAKEN_DOWN });
    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(purchases[0].meta ?? null).toBeNull();
  });

  it('stops stamping purchases once a takedown lands mid-call', async () => {
    mocks.revokeCosmeticsFromUsers.mockImplementation(async () => {
      itemMeta = { ...itemMeta, takedown: { reason: 'tos', moderatorId: MOD, at: MARKED_AT } };
      return { revoked: 1 };
    });

    const result = await refund(['p-1', 'p-2']);

    expect(result.results.map((r) => [r.status, r.error])).toEqual([
      ['refunded', undefined],
      ['failed', TAKEN_DOWN],
    ]);
    expect(purchases[1].meta ?? null).toBeNull();
  });

  it('moves nothing while another refund of the item holds the lock', async () => {
    locks.held.add(`creator-shop-withdrawn-refund:${ITEM}`);

    const result = await refund(['p-1']);

    expect(result.results[0]).toMatchObject({
      status: 'failed',
      error: 'another refund of this item is running; try again',
    });
    expect(mocks.refundTransaction).not.toHaveBeenCalled();
    expect(purchases[0].refunded).toBe(false);
  });

  it('refunds the purchases of another item while one item is busy', async () => {
    const OTHER = 43;
    purchases = [sale(101, 'p-1'), { ...sale(102, 'q-1'), shopItemId: OTHER }];
    // The busy item comes second, so marking it busy must not touch what the first one refunded.
    locks.held.add(`creator-shop-withdrawn-refund:${OTHER}`);

    const result = await refund(['p-1', 'q-1']);

    expect(result.results.map((r) => [r.buzzTransactionId, r.shopItemId, r.status])).toEqual([
      ['p-1', ITEM, 'refunded'],
      ['q-1', OTHER, 'failed'],
    ]);
    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout']);
    expect(dbMock.dbWrite.$executeRaw.mock.calls.map((call) => call.at(-1))).toEqual([ITEM]);
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 101,
        key: expect.stringMatching(new RegExp(`^cosmetic-shop-purchase-refunded:${ITEM}:101:`)),
      })
    );
  });

  it('skips a purchase another run refunded between the first read and the lock', async () => {
    const read = dbMock.dbWrite.userCosmeticShopPurchases.findMany.getMockImplementation()!;
    let reads = 0;
    dbMock.dbWrite.userCosmeticShopPurchases.findMany.mockImplementation(async (args) => {
      if (++reads === 2) purchases[0].refunded = true;
      return read(args);
    });

    const result = await refund(['p-1']);

    expect(result.results[0].status).toBe('skipped-already-refunded');
    expect(mocks.refundTransaction).not.toHaveBeenCalled();
  });

  it('takes each purchase once when it is named twice', async () => {
    const result = await refund(['p-1', 'p-1']);

    expect(result.results).toHaveLength(1);
    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout']);
  });

  it('records what moved when a later purchase throws', async () => {
    const working = mocks.refundTransaction.getMockImplementation()!;
    mocks.refundTransaction.mockImplementation(async (transactionId: string) => {
      if (transactionId === 'p-1-payout') throw new Error('creator account locked');
      return working(transactionId);
    });
    mocks.revokeCosmeticsFromUsers.mockImplementation(async ({ userIds }) => {
      if (userIds[0] === 102) throw new Error('db down');
      return { revoked: 1 };
    });
    loggingMock.logToAxiom.mockClear();

    const result = await refund(['p-1', 'p-2']);

    expect(result.results.map((r) => [r.status, r.error])).toEqual([
      ['refunded', undefined],
      ['failed', 'db down'],
    ]);
    expect(result.results[0].payoutFailures).toEqual([
      expect.objectContaining({ transactionId: 'p-1-payout', error: 'creator account locked' }),
    ]);
    const logged = loggingMock.logToAxiom.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.name === 'creator-shop-purchase-refund')
      .map((entry) => entry.message);
    expect(logged).toEqual(['Payout clawback failed', 'Purchase refund finished']);
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
  });

  it('leaves a purchase the ledger refuses unstamped, so the job does not retry it', async () => {
    purchases[0].unitAmount = 1200;

    const result = await refund(['p-1']);

    expect(result.results[0]).toMatchObject({
      status: 'failed',
      error: 'debits 1000 do not match the price 1200',
    });
    expect(purchases[0].meta ?? null).toBeNull();
    // With no marker on the item, only a stamp would put the purchase in front of the job.
    expect(await refundWithdrawnShopItem(ITEM)).toEqual({ purchases: 0, refunded: 0, failures: 0 });
    expect(mocks.refundTransaction).not.toHaveBeenCalled();
  });

  /** Runs `during` the next time the purchase ledger is read, then reads it as usual. */
  const onLedgerRead = (during: () => void) => {
    const rows = ledger.rows;
    const read = rows.get.bind(rows);
    rows.get = (key: string) => {
      delete (rows as { get?: unknown }).get;
      during();
      return read(key);
    };
  };

  it('leaves a purchase unstamped when the ledger read fails, and a second call refunds it', async () => {
    onLedgerRead(() => {
      throw new Error('buzz 503');
    });

    const first = await refund(['p-1']);

    expect(first.results[0]).toMatchObject({ status: 'failed', error: 'buzz 503' });
    expect(purchases[0].meta ?? null).toBeNull();

    const second = await refund(['p-1']);

    expect(second.results[0].status).toBe('refunded');
    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout']);
  });

  it('leaves the purchase to a takedown that lands during the ledger read', async () => {
    onLedgerRead(() => {
      itemMeta = { ...itemMeta, takedown: { reason: 'tos', moderatorId: MOD, at: MARKED_AT } };
    });

    const result = await refund(['p-1']);

    expect(result.results[0]).toMatchObject({ status: 'failed', error: TAKEN_DOWN });
    expect(purchases[0].meta ?? null).toBeNull();
    expect(mocks.refundTransaction).not.toHaveBeenCalled();
  });

  it('reverses the payouts when a takedown lands just after the stamp', async () => {
    const stamp = dbMock.dbWrite.userCosmeticShopPurchases.update.getMockImplementation()!;
    dbMock.dbWrite.userCosmeticShopPurchases.update.mockImplementation(async (args) => {
      const row = await stamp(args);
      itemMeta = { ...itemMeta, takedown: { reason: 'tos', moderatorId: MOD, at: MARKED_AT } };
      return row;
    });

    const result = await refund(['p-1'], { clawback: false });

    expect(result.results[0].status).toBe('refunded');
    expect(refundedIds()).toEqual(['p-1-debit', 'p-1-payout']);
  });

  it('leaves a part-done purchase stamped, and the job finishes it', async () => {
    const working = mocks.refundTransaction.getMockImplementation()!;
    mocks.refundTransaction.mockImplementation(async (transactionId: string) => {
      if (transactionId === 'p-1-debit') throw new Error('buzz 503');
      return working(transactionId);
    });

    const first = await refund(['p-1']);
    mocks.refundTransaction.mockImplementation(working);

    expect(first.results[0]).toMatchObject({ status: 'failed' });
    expect(purchases[0].meta).toEqual({
      withdrawnRefund: expect.objectContaining({ trigger: 'manual', clawback: true, userId: MOD }),
    });

    const swept = await refundWithdrawnShopItem(ITEM);

    expect(swept).toEqual({ purchases: 1, refunded: 1, failures: 0 });
    expect(purchases.map((p) => p.refunded)).toEqual([true, false]);
    expect(ledger.refunded).toEqual(new Set(['p-1-debit', 'p-1-payout']));
  });
});
