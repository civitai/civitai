import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as ChatService from '~/server/services/chat.service';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as CreatorShop from '~/server/services/creator-shop.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The Creator Services deal state machine and its escrow, run against the real P0 migration on an
 * in-process Postgres. Only the Buzz service, the chat side effects and the lock are faked; every
 * claim, transition and receipt is the production SQL.
 */

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const buzz = vi.hoisted(() => ({
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getTransactionByExternalId: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  ...buzz,
}));

const chat = vi.hoisted(() => ({ upsertDealChat: vi.fn(), createMessage: vi.fn() }));
vi.mock('~/server/services/chat.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatService>()),
  ...chat,
}));

const shop = vi.hoisted(() => ({ assertCreatorShopVisible: vi.fn() }));
vi.mock('~/server/services/creator-shop.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorShop>()),
  ...shop,
}));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));

// A real mutex, as in placement-escrow's suite: a pass-through would hide a double payment.
const locks = vi.hoisted(() => ({ held: new Set<string>(), available: true }));
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async (options: { key: string }, operation: () => Promise<unknown>) => {
    if (!locks.available || locks.held.has(options.key)) return null;
    locks.held.add(options.key);
    try {
      return await operation();
    } finally {
      locks.held.delete(options.key);
    }
  },
}));

type Raw = ReturnType<typeof pgliteRaw>;
const bridge = (db: { query: PGlite['query'] }) => {
  const raw = pgliteRaw(db as PGlite);
  return { $executeRaw: raw.executeRaw, $queryRaw: raw.queryRaw };
};
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbRead.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
  holder.db.transaction((tx) => fn(bridge(tx)))) as never);

const deals = await import('~/server/services/creator-service-deal.service');
const escrow = await import('~/server/services/creator-service-escrow.service');
const { MAX_LEG_ATTEMPTS } = await import('~/server/services/placement-escrow.service');

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261025120000_creator_services_foundation/migration.sql'
);

const SELLER = 1;
const BUYER = 2;
const STRANGER = 3;
const PRICE = 500;

const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

const deal = async (id: number) =>
  (
    await q<{
      status: string;
      heldAt: Date | null;
      settledAt: Date | null;
      price: number;
      buzzType: string;
      revisionsIncluded: number;
      revisionsUsed: number;
      deliveryDays: number;
      previewKind: string;
      closeReason: string | null;
      acceptedAt: Date | null;
      dueAt: Date | null;
      releaseAt: Date | null;
      completedAt: Date | null;
    }>(`SELECT * FROM "ServiceDeal" WHERE id = $1`, [id])
  )[0];

const legs = (id: number) =>
  q<{
    leg: string;
    amount: number;
    transactionId: string | null;
    attempts: number;
    lastError: string | null;
  }>(
    `SELECT leg::text, amount, "transactionId", attempts, "lastError" FROM "ServiceDealTransaction"
     WHERE "dealId" = $1 ORDER BY id`,
    [id]
  );

const events = async (id: number) =>
  (
    await q<{ type: string }>(
      `SELECT type::text FROM "ServiceDealEvent" WHERE "dealId" = $1 ORDER BY id`,
      [id]
    )
  ).map((e) => e.type);

const charged = (amount = PRICE) => ({
  transactionIds: [{ transactionId: 'tx-hold', accountType: 'yellow', amount, duplicate: false }],
  totalAmount: amount,
  transactionCount: 1,
});

const buzzError = (status: number) =>
  new TRPCError({ code: 'BAD_REQUEST', cause: new BuzzApiError(status, 'buzz said no') });

const request = (overrides: Partial<Parameters<typeof deals.requestServiceDeal>[0]> = {}) =>
  deals.requestServiceDeal({
    offeringId: 1,
    expectedPrice: PRICE,
    buyerId: BUYER,
    requestText: 'please draw my cat',
    buzzType: 'yellow',
    ...overrides,
  });

/** Moves a deal's clock instead of the test's: time is an input. */
const age = (id: number, column: string, hours: number) =>
  q(
    `UPDATE "ServiceDeal" SET "${column}" = now() - make_interval(hours => ${hours}) WHERE id = $1`,
    [id]
  );

const ageHoldLeg = (id: number, minutes: number) =>
  q(
    `UPDATE "ServiceDealTransaction" SET "createdAt" = now() - make_interval(mins => ${minutes})
     WHERE "dealId" = $1 AND leg = 'Hold'`,
    [id]
  );

const conflict = expect.objectContaining({ code: 'CONFLICT' });

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp, muted boolean NOT NULL DEFAULT false);
    CREATE TYPE "UserEngagementType" AS ENUM ('Hide', 'Follow', 'Block');
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type "UserEngagementType");
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  vi.clearAllMocks();
  // clearAllMocks keeps a queued *Once; a test that fails early would leak it into the next.
  for (const fn of Object.values(buzz)) fn.mockReset();
  locks.available = true;
  locks.held.clear();
  buzz.createMultiAccountBuzzTransaction.mockResolvedValue(charged());
  buzz.refundMultiAccountTransaction.mockImplementation(
    async ({ externalTransactionIdPrefix }) => ({
      refundedTransactions: [
        {
          originalTransactionId: 'tx-hold',
          refundTransactionId: 'tx-refund',
          accountType: 'yellow',
          amount: PRICE,
        },
      ],
      externalTransactionIdPrefix,
    })
  );
  buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([]);
  chat.upsertDealChat.mockResolvedValue({ id: 77 });
  chat.createMessage.mockResolvedValue({});
  shop.assertCreatorShopVisible.mockResolvedValue([]);
  await holder.db.exec(`
    TRUNCATE "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFile", "ServiceDeal", "ServiceOffering", "UserEngagement" RESTART IDENTITY;
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER}), (${STRANGER});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "revisionsIncluded", "previewKind", status, "updatedAt")
      VALUES (${SELLER}, 'Cat portraits', 'desc', ${PRICE}, 3, 1, 'Video', 'Active', now());
  `);
});

describe('request', () => {
  it("copies the offering's terms into the deal and holds exactly its price from the buyer", async () => {
    const { id, held } = await request();
    expect(held).toBe(true);
    expect(await deal(id)).toMatchObject({
      status: 'Requested',
      price: PRICE,
      buzzType: 'yellow',
      revisionsIncluded: 1,
      deliveryDays: 3,
      previewKind: 'Video',
    });
    expect((await deal(id)).heldAt).not.toBeNull();
    expect(buzz.createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.createMultiAccountBuzzTransaction.mock.calls[0][0]).toMatchObject({
      amount: PRICE,
      fromAccountId: BUYER,
      fromAccountTypes: ['yellow'],
      toAccountId: 0,
      toAccountType: 'yellow',
      type: 29,
      externalTransactionIdPrefix: `creator-service-${id}-hold`,
    });
    expect(await legs(id)).toEqual([
      expect.objectContaining({
        leg: 'Hold',
        amount: PRICE,
        transactionId: `creator-service-${id}-hold`,
      }),
    ]);
    expect(await events(id)).toEqual(['Requested', 'Held']);
  });

  it('refuses a request at a price other than the one the buyer was shown', async () => {
    await q(`UPDATE "ServiceOffering" SET price = 50000`);
    await expect(request()).rejects.toEqual(conflict);
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses a second unanswered request from the same buyer, so a doubled submit holds once', async () => {
    await request();
    await expect(request()).rejects.toEqual(conflict);
    expect(buzz.createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(1);
    // Another buyer, or the same buyer once the first is answered, is unaffected.
    await request({ buyerId: STRANGER });
    const [{ id }] = await q<{ id: number }>(`SELECT id FROM "ServiceDeal" WHERE "buyerId" = $1`, [
      BUYER,
    ]);
    await deals.declineServiceDeal({ dealId: id, userId: SELLER });
    await request();
    expect(buzz.createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(3);
  });

  it('holds the price the offering has when requested, not one changed afterwards', async () => {
    const { id } = await request();
    await q(`UPDATE "ServiceOffering" SET price = 9999`);
    expect((await deal(id)).price).toBe(PRICE);
  });

  it('takes green when the domain is green', async () => {
    const { id } = await request({ buzzType: 'green' });
    expect((await deal(id)).buzzType).toBe('green');
    expect(buzz.createMultiAccountBuzzTransaction.mock.calls[0][0]).toMatchObject({
      fromAccountTypes: ['green'],
      toAccountType: 'green',
    });
  });

  // Justin, v1: no Blue. Blue is not transferable, and a paid service would be a way to move it.
  it('refuses blue outright: no deal, no charge', async () => {
    await expect(request({ buzzType: 'blue' })).rejects.toThrow(/cannot be paid in blue/);
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses buying your own service, across a block, and past the open-deal cap', async () => {
    await expect(request({ buyerId: SELLER })).rejects.toThrow(/your own service/);
    await q(`INSERT INTO "UserEngagement" VALUES ($1, $2, 'Block')`, [SELLER, BUYER]);
    await expect(request()).rejects.toThrow(/cannot request this service/);
    await q(`DELETE FROM "UserEngagement"`);
    await q(`UPDATE "ServiceOffering" SET "maxOpenDeals" = 1`);
    await request();
    await expect(request({ buyerId: STRANGER })).rejects.toThrow(/not taking new requests/);
    expect(buzz.createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(1);
  });

  // P1's storefront rules: a banned, deleted or muted seller sells nothing, and an off or private
  // shop takes no requests, even from a buyer who still has the offering's link.
  it.each([
    ['banned', `"bannedAt" = now()`],
    ['deleted', `"deletedAt" = now()`],
    ['muted', `muted = true`],
  ])('refuses a request to a %s seller, before any charge', async (_name, set) => {
    await q(`UPDATE "User" SET ${set} WHERE id = $1`, [SELLER]);
    await expect(request()).rejects.toThrow(/Service not found/);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses a request when the shop is not visible to the buyer', async () => {
    shop.assertCreatorShopVisible.mockRejectedValue(new Error('Shop not found'));
    await expect(request()).rejects.toThrow(/Shop not found/);
    expect(shop.assertCreatorShopVisible).toHaveBeenCalledWith({ userId: SELLER, viewerId: BUYER });
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
  });

  it('cancels a request the Buzz service refused, and refunds nothing', async () => {
    buzz.createMultiAccountBuzzTransaction.mockRejectedValue(buzzError(400));
    await expect(request()).rejects.toThrow();
    const [{ id }] = await q<{ id: number }>(`SELECT id FROM "ServiceDeal"`);
    expect(await deal(id)).toMatchObject({
      status: 'Cancelled',
      closeReason: 'payment_refused',
      heldAt: null,
    });
    expect((await legs(id)).map((l) => l.leg)).toEqual(['Hold']);
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
  });
});

describe('a hold whose outcome is unknown', () => {
  const unknownHold = async (buyerId = BUYER) => {
    buzz.createMultiAccountBuzzTransaction.mockRejectedValueOnce(buzzError(504));
    const result = await request({ buyerId });
    expect(result.held).toBe(false);
    return result.id;
  };

  it('cannot be accepted until the charge is found, then can', async () => {
    const id = await unknownHold();
    await expect(deals.acceptServiceDeal({ dealId: id, userId: SELLER })).rejects.toEqual(conflict);

    await ageHoldLeg(id, 11);
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      {
        accountId: BUYER,
        amount: PRICE,
        transactionId: 't',
        externalTransactionId: 'x',
        accountType: 'yellow',
      },
    ]);
    expect(await escrow.reconcileUnconfirmedHolds()).toMatchObject({ held: 1 });
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    expect((await deal(id)).status).toBe('Accepted');
  });

  it('is not looked up while a write could still be in flight', async () => {
    await unknownHold();
    expect(await escrow.reconcileUnconfirmedHolds()).toMatchObject({ considered: 0 });
    expect(buzz.getMultiAccountTransactionsByPrefix).not.toHaveBeenCalled();
  });

  it('cancels when nothing was charged, and a charge landing later is refunded, never accepted', async () => {
    const id = await unknownHold();
    await ageHoldLeg(id, 11);
    expect(await escrow.reconcileUnconfirmedHolds()).toMatchObject({ cancelled: 1 });
    expect(await deal(id)).toMatchObject({ status: 'Cancelled', closeReason: 'payment_failed' });

    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      {
        accountId: BUYER,
        amount: PRICE,
        transactionId: 't',
        externalTransactionId: 'x',
        accountType: 'yellow',
      },
    ]);
    await escrow.reconcileUnconfirmedHolds();
    // The seller can never accept it: the deal is closed, however it got its hold.
    await expect(deals.acceptServiceDeal({ dealId: id, userId: SELLER })).rejects.toEqual(conflict);
    expect(await deal(id)).toMatchObject({ status: 'Cancelled' });
    expect((await deal(id)).settledAt).not.toBeNull();
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.refundMultiAccountTransaction.mock.calls[0][0]).toMatchObject({
      externalTransactionIdPrefix: `creator-service-${id}-hold`,
    });
  });

  it('is never refunded while unconfirmed: a withdrawal waits for the charge to be found', async () => {
    const id = await unknownHold();
    await deals.withdrawServiceDeal({ dealId: id, userId: BUYER });
    expect(await deal(id)).toMatchObject({ status: 'Cancelled', closeReason: 'withdrawn' });
    await escrow.sweepServiceDealRefunds();
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect((await legs(id)).map((l) => l.leg)).toEqual(['Hold']);

    await ageHoldLeg(id, 11);
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      {
        accountId: BUYER,
        amount: PRICE,
        transactionId: 't',
        externalTransactionId: 'x',
        accountType: 'yellow',
      },
    ]);
    await escrow.reconcileUnconfirmedHolds();
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
  });

  it('treats a charge the ledger calls a duplicate as unknown, not as paid', async () => {
    buzz.createMultiAccountBuzzTransaction.mockResolvedValueOnce({
      ...charged(),
      transactionIds: [
        { transactionId: 't', accountType: 'yellow', amount: PRICE, duplicate: true },
      ],
    });
    const { id, held } = await request();
    expect(held).toBe(false);
    expect((await deal(id)).heldAt).toBeNull();
  });

  it('rotates the batch, so holds that keep finding nothing cannot starve one that landed', async () => {
    const first = await unknownHold();
    const second = await unknownHold(STRANGER);
    await ageHoldLeg(first, 12);
    await ageHoldLeg(second, 11);
    await deals.withdrawServiceDeal({ dealId: first, userId: BUYER });
    await escrow.reconcileUnconfirmedHolds({ limit: 1 });
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      {
        accountId: STRANGER,
        amount: PRICE,
        transactionId: 't',
        externalTransactionId: 'x',
        accountType: 'yellow',
      },
    ]);
    await escrow.reconcileUnconfirmedHolds({ limit: 1 });
    expect((await deal(second)).heldAt).not.toBeNull();
  });

  it('is left for a human when only part of the price moved', async () => {
    const id = await unknownHold();
    await ageHoldLeg(id, 11);
    buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
      {
        accountId: BUYER,
        amount: 100,
        transactionId: 't',
        externalTransactionId: 'x',
        accountType: 'yellow',
      },
    ]);
    await escrow.reconcileUnconfirmedHolds();
    expect(await deal(id)).toMatchObject({ status: 'Requested', heldAt: null });
  });
});

describe('closing with a refund', () => {
  it('declines: refunds the receipted hold amount by the hold prefix, once', async () => {
    const { id } = await request();
    await deals.declineServiceDeal({ dealId: id, userId: SELLER, reason: 'too busy' });
    expect(await deal(id)).toMatchObject({ status: 'Declined', closeReason: 'declined' });
    expect((await deal(id)).settledAt).not.toBeNull();
    expect(await legs(id)).toEqual([
      expect.objectContaining({ leg: 'Hold' }),
      expect.objectContaining({
        leg: 'Refund',
        amount: PRICE,
        transactionId: `creator-service-${id}-hold`,
      }),
    ]);
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(await events(id)).toEqual(['Requested', 'Held', 'Declined', 'Refunded']);

    // A second close and a sweep pay nothing more.
    await expect(deals.declineServiceDeal({ dealId: id, userId: SELLER })).rejects.toEqual(
      conflict
    );
    await escrow.sweepServiceDealRefunds();
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
  });

  it('pays one refund when two closes race', async () => {
    const { id } = await request();
    await age(id, 'requestedAt', 49);
    const results = await Promise.allSettled([
      deals.declineServiceDeal({ dealId: id, userId: SELLER }),
      deals.expireServiceDeals(),
      deals.withdrawServiceDeal({ dealId: id, userId: BUYER }),
    ]);
    expect(results.filter((r) => r.status === 'rejected').length).toBeGreaterThanOrEqual(1);
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect((await legs(id)).filter((l) => l.leg === 'Refund')).toHaveLength(1);
  });

  it('only the parties can close: a stranger, or the wrong party, moves nothing', async () => {
    const { id } = await request();
    await expect(deals.declineServiceDeal({ dealId: id, userId: BUYER })).rejects.toEqual(conflict);
    await expect(deals.withdrawServiceDeal({ dealId: id, userId: SELLER })).rejects.toEqual(
      conflict
    );
    await expect(deals.withdrawServiceDeal({ dealId: id, userId: STRANGER })).rejects.toEqual(
      conflict
    );
    expect((await deal(id)).status).toBe('Requested');
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('expires a request after 48 hours, and not before', async () => {
    const fresh = (await request()).id;
    const stale = (await request({ buyerId: STRANGER })).id;
    await age(fresh, 'requestedAt', 47);
    await age(stale, 'requestedAt', 49);
    expect(await deals.expireServiceDeals()).toMatchObject({ moved: 1 });
    expect((await deal(stale)).status).toBe('Expired');
    expect((await deal(fresh)).status).toBe('Requested');
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
  });

  it('retries a failed refund after backoff, and stops at the ceiling', async () => {
    const { id } = await request();
    buzz.refundMultiAccountTransaction.mockRejectedValue(buzzError(503));
    await deals.declineServiceDeal({ dealId: id, userId: SELLER });
    expect((await deal(id)).settledAt).toBeNull();
    expect((await legs(id)).find((l) => l.leg === 'Refund')).toMatchObject({
      attempts: 1,
      transactionId: null,
    });

    // Inside the backoff: the sweep does not call Buzz again.
    await escrow.sweepServiceDealRefunds();
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);

    for (let attempt = 2; attempt <= MAX_LEG_ATTEMPTS + 2; attempt++) {
      await q(
        `UPDATE "ServiceDealTransaction" SET "lastAttemptAt" = now() - interval '1 day' WHERE leg = 'Refund'`
      );
      await escrow.sweepServiceDealRefunds();
    }
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(MAX_LEG_ATTEMPTS);

    buzz.refundMultiAccountTransaction.mockResolvedValue({
      refundedTransactions: [
        {
          originalTransactionId: 'a',
          refundTransactionId: 'b',
          accountType: 'yellow',
          amount: PRICE,
        },
      ],
      externalTransactionIdPrefix: 'p',
    });
    await escrow.sweepServiceDealRefunds();
    expect((await deal(id)).settledAt).toBeNull();
  });

  it('refuses a leg past its ceiling to any caller, not only the sweep', async () => {
    const { id } = await request();
    buzz.refundMultiAccountTransaction.mockRejectedValue(buzzError(503));
    await deals.declineServiceDeal({ dealId: id, userId: SELLER });
    await q(
      `UPDATE "ServiceDealTransaction" SET attempts = ${MAX_LEG_ATTEMPTS}, "lastAttemptAt" = now() - interval '1 day'
       WHERE leg = 'Refund'`
    );
    buzz.refundMultiAccountTransaction.mockClear();
    expect(await escrow.refundDeal(id)).toBe(false);
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  describe('a refund answered 409', () => {
    // A 409 means at least ONE leg under the prefix already has a refund, and reverses none of the
    // rest (Buzz owner, 2026-10-15). The ledger decides: each leg's `refund-<transactionId>`.
    const holdLegs = [
      {
        accountId: BUYER,
        amount: 300,
        transactionId: 'leg-a',
        externalTransactionId: 'x',
        accountType: 'yellow',
      },
      {
        accountId: BUYER,
        amount: 200,
        transactionId: 'leg-b',
        externalTransactionId: 'x',
        accountType: 'yellow',
      },
    ];
    const refundRow = { date: '2026-10-15', type: 'Refund', amount: 1 };
    const refunded = (...ids: string[]) =>
      buzz.getTransactionByExternalId.mockImplementation(async (externalId: string) =>
        ids.some((id) => externalId === `refund-${id}`) ? refundRow : null
      );
    const refundLeg = async (id: number) => (await legs(id)).find((l) => l.leg === 'Refund');

    beforeEach(() => {
      buzz.refundMultiAccountTransaction.mockRejectedValue(buzzError(409));
      buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue(holdLegs);
    });

    it('settles when every hold leg has its refund', async () => {
      refunded('leg-a', 'leg-b');
      const { id } = await request();
      await deals.declineServiceDeal({ dealId: id, userId: SELLER });
      expect((await deal(id)).settledAt).not.toBeNull();
      expect(await refundLeg(id)).toMatchObject({
        transactionId: `creator-service-${id}-hold:already-refunded`,
      });
      expect(buzz.getMultiAccountTransactionsByPrefix).toHaveBeenCalledWith(
        `creator-service-${id}-hold`
      );
      expect(buzz.getTransactionByExternalId.mock.calls.map((c) => c[0])).toEqual([
        'refund-leg-a',
        'refund-leg-b',
      ]);
    });

    it('stays refund-pending when one leg has no refund, naming that leg', async () => {
      refunded('leg-a');
      const { id } = await request();
      await deals.declineServiceDeal({ dealId: id, userId: SELLER });
      expect((await deal(id)).settledAt).toBeNull();
      const leg = await refundLeg(id);
      expect(leg).toMatchObject({ transactionId: null, attempts: 1 });
      expect(leg?.lastError).toMatch(/not fully refunded: unrefunded legs leg-b$/);
    });

    it('stays refund-pending when a refund lookup fails', async () => {
      buzz.getTransactionByExternalId.mockRejectedValue(new Error('buzz unreachable'));
      const { id } = await request();
      await deals.declineServiceDeal({ dealId: id, userId: SELLER });
      expect((await deal(id)).settledAt).toBeNull();
      expect(await refundLeg(id)).toMatchObject({
        transactionId: null,
        lastError: 'buzz unreachable',
      });
    });

    it('stays refund-pending when the ledger lists less than was held', async () => {
      refunded('leg-a', 'leg-b');
      buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue(holdLegs.slice(0, 1));
      const { id } = await request();
      await deals.declineServiceDeal({ dealId: id, userId: SELLER });
      expect((await deal(id)).settledAt).toBeNull();
      expect((await refundLeg(id))?.lastError).toMatch(/ledger lists 300 of 500/);
    });

    it('stays refund-pending when the ledger lists no legs at all', async () => {
      const { id } = await request();
      buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([]);
      await deals.declineServiceDeal({ dealId: id, userId: SELLER });
      expect((await deal(id)).settledAt).toBeNull();
      expect((await refundLeg(id))?.lastError).toMatch(/ledger lists 0 of 500/);
    });

    it('settles on a later retry once the ledger shows every leg refunded', async () => {
      refunded('leg-a');
      const { id } = await request();
      await deals.declineServiceDeal({ dealId: id, userId: SELLER });
      expect((await deal(id)).settledAt).toBeNull();

      refunded('leg-a', 'leg-b');
      await q(
        `UPDATE "ServiceDealTransaction" SET "lastAttemptAt" = now() - interval '1 day' WHERE leg = 'Refund'`
      );
      await escrow.sweepServiceDealRefunds();
      expect((await deal(id)).settledAt).not.toBeNull();
      expect(await events(id)).toContain('Refunded');
    });

    // Decision (briony, 2026-10-15): paying a missing leg with the single-transaction refund waits
    // on the Buzz owners confirming that endpoint is safe to repeat. Delete this only with that
    // answer in hand, when the missing legs start being paid here.
    it('never pays a missing leg itself while single-leg refunds are parked', async () => {
      refunded();
      const { id } = await request();
      await deals.declineServiceDeal({ dealId: id, userId: SELLER });
      for (let attempt = 2; attempt <= MAX_LEG_ATTEMPTS; attempt++) {
        await q(
          `UPDATE "ServiceDealTransaction" SET "lastAttemptAt" = now() - interval '1 day' WHERE leg = 'Refund'`
        );
        await escrow.sweepServiceDealRefunds();
      }
      expect(buzz.refundTransaction).not.toHaveBeenCalled();
      expect(await refundLeg(id)).toMatchObject({
        transactionId: null,
        attempts: MAX_LEG_ATTEMPTS,
      });
      expect(await escrow.sweepServiceDealRefunds()).toMatchObject({ exhausted: 1 });
      expect((await deal(id)).settledAt).toBeNull();
    });
  });

  it('does not receipt a refund that moved nothing', async () => {
    const { id } = await request();
    buzz.refundMultiAccountTransaction.mockResolvedValue({
      refundedTransactions: [],
      externalTransactionIdPrefix: 'p',
    });
    await deals.declineServiceDeal({ dealId: id, userId: SELLER });
    expect((await legs(id)).find((l) => l.leg === 'Refund')).toMatchObject({ transactionId: null });
    expect((await deal(id)).settledAt).toBeNull();
  });
});

describe('the Refund claim', () => {
  // Requirement: the claim's ON CONFLICT names (dealId, leg) only, so a Release already holding
  // the deal's payout slot RAISES instead of being read as "this refund is already claimed".
  it('raises when the deal already has a Release, rather than treating it as claimed', async () => {
    const { id } = await request();
    await q(`UPDATE "ServiceDeal" SET status = 'Declined', "closedAt" = now() WHERE id = $1`, [id]);
    await q(
      `INSERT INTO "ServiceDealTransaction" ("dealId", leg, "externalTransactionId", amount, "buzzType")
       VALUES ($1, 'Release', 'r', $2, 'yellow')`,
      [id, PRICE]
    );
    await expect(escrow.claimRefund(dbMock.dbWrite as never, id)).rejects.toThrow(
      /ServiceDealTransaction_dealId_payout_key/
    );
  });

  // The two halves of "confirmed" are each required on their own, so neither can be dropped as
  // redundant: the deal's marker, and a receipted Hold row whose amount is what is refunded.
  it('claims nothing when the deal is marked held but no Hold receipt exists', async () => {
    buzz.createMultiAccountBuzzTransaction.mockRejectedValueOnce(buzzError(504));
    const { id } = await request();
    await q(
      `UPDATE "ServiceDeal" SET status = 'Cancelled', "closedAt" = now(), "heldAt" = now() WHERE id = $1`,
      [id]
    );
    expect(await escrow.claimRefund(dbMock.dbWrite as never, id)).toBe(false);
  });

  it('claims nothing when the Hold is receipted but the deal is not marked held', async () => {
    buzz.createMultiAccountBuzzTransaction.mockRejectedValueOnce(buzzError(504));
    const { id } = await request();
    await q(`UPDATE "ServiceDeal" SET status = 'Cancelled', "closedAt" = now() WHERE id = $1`, [
      id,
    ]);
    await q(`UPDATE "ServiceDealTransaction" SET "transactionId" = 'x' WHERE "dealId" = $1`, [id]);
    expect(await escrow.claimRefund(dbMock.dbWrite as never, id)).toBe(false);
  });

  // Plan rule: the status change and the Pending receipt commit together. Inside one transaction
  // now() is the transaction's start, so the two timestamps are equal only if they did.
  it('is written in the same transaction that closes the deal', async () => {
    buzz.refundMultiAccountTransaction.mockRejectedValue(buzzError(503));
    const { id } = await request();
    await deals.declineServiceDeal({ dealId: id, userId: SELLER });
    const [row] = await q<{ same: boolean }>(
      `SELECT t."createdAt" = d."closedAt" AS same FROM "ServiceDealTransaction" t
       JOIN "ServiceDeal" d ON d.id = t."dealId" WHERE t."dealId" = $1 AND t.leg = 'Refund'`,
      [id]
    );
    expect(row).toEqual({ same: true });
  });

  it('claims nothing for a deal whose hold is unconfirmed', async () => {
    buzz.createMultiAccountBuzzTransaction.mockRejectedValueOnce(buzzError(504));
    const { id } = await request();
    await q(`UPDATE "ServiceDeal" SET status = 'Cancelled', "closedAt" = now() WHERE id = $1`, [
      id,
    ]);
    expect(await escrow.claimRefund(dbMock.dbWrite as never, id)).toBe(false);
    expect((await legs(id)).map((l) => l.leg)).toEqual(['Hold']);
  });
});

describe('working a deal', () => {
  const accepted = async () => {
    const { id } = await request();
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    return id;
  };

  it('accepts: sets the due date from the snapshot and opens the deal chat', async () => {
    const id = await accepted();
    const row = await deal(id);
    expect(row.status).toBe('Accepted');
    expect(row.dueAt!.getTime() - row.acceptedAt!.getTime()).toBe(3 * 86_400_000);
    expect(chat.upsertDealChat).toHaveBeenCalledWith({ sellerId: SELLER, buyerId: BUYER });
    expect(chat.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: -1, chatId: 77 })
    );
  });

  it('refuses an accept across a block made since the request', async () => {
    const { id } = await request();
    await q(`INSERT INTO "UserEngagement" VALUES ($1, $2, 'Block')`, [BUYER, SELLER]);
    await expect(deals.acceptServiceDeal({ dealId: id, userId: SELLER })).rejects.toEqual(conflict);
  });

  it('lets the buyer leave a day past due, not before', async () => {
    const id = await accepted();
    await expect(deals.cancelLateServiceDeal({ dealId: id, userId: BUYER })).rejects.toEqual(
      conflict
    );
    await q(`UPDATE "ServiceDeal" SET "dueAt" = now() - interval '25 hours' WHERE id = $1`, [id]);
    await deals.cancelLateServiceDeal({ dealId: id, userId: BUYER });
    expect(await deal(id)).toMatchObject({ status: 'Cancelled', closeReason: 'late' });
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
  });

  // Requesting a revision must not turn an on-time delivery into an instant refund.
  it('never offers the late cancel once anything was delivered', async () => {
    const id = await accepted();
    await deals.markServiceDealDelivered({ dealId: id, userId: SELLER });
    await deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'tweak' });
    await q(`UPDATE "ServiceDeal" SET "dueAt" = now() - interval '5 days' WHERE id = $1`, [id]);
    await expect(deals.cancelLateServiceDeal({ dealId: id, userId: BUYER })).rejects.toEqual(
      conflict
    );
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('counts revisions against the snapshot and completes with a 48h dispute window', async () => {
    const id = await accepted();
    await deals.markServiceDealDelivered({ dealId: id, userId: SELLER });
    await deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'bigger ears' });
    await deals.markServiceDealDelivered({ dealId: id, userId: SELLER });
    await expect(
      deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'again' })
    ).rejects.toEqual(conflict);

    await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
    const row = await deal(id);
    expect(row.status).toBe('Completed');
    expect(row.releaseAt!.getTime() - row.completedAt!.getTime()).toBe(48 * 3_600_000);
    // P2 never pays the release.
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect((await legs(id)).map((l) => l.leg)).toEqual(['Hold']);
  });

  it('auto-completes 3 days after delivery, and not before', async () => {
    const id = await accepted();
    await deals.markServiceDealDelivered({ dealId: id, userId: SELLER });
    await age(id, 'deliveredAt', 71);
    expect(await deals.autoCompleteServiceDeals()).toMatchObject({ moved: 0 });
    await age(id, 'deliveredAt', 73);
    expect(await deals.autoCompleteServiceDeals()).toMatchObject({ moved: 1 });
    expect((await deal(id)).status).toBe('Completed');
  });

  it('opens a dispute inside the window only', async () => {
    const id = await accepted();
    await deals.markServiceDealDelivered({ dealId: id, userId: SELLER });
    await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
    await q(`UPDATE "ServiceDeal" SET "releaseAt" = now() - interval '1 minute' WHERE id = $1`, [
      id,
    ]);
    await expect(
      deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'zip is empty' })
    ).rejects.toEqual(conflict);
    await q(`UPDATE "ServiceDeal" SET "releaseAt" = now() + interval '1 hour' WHERE id = $1`, [id]);
    await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'zip is empty' });
    expect((await deal(id)).status).toBe('Disputed');
  });
});

describe('timed transitions re-check their own deadline', () => {
  // The sweeps select by deadline, but the deal can move between that SELECT and the UPDATE.
  it('will not expire, auto-complete or auto-cancel a deal whose clock has not run out', async () => {
    const id = (await request()).id;
    expect(await deals.expireServiceDeal(id)).toBe(false);

    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    await deals.markServiceDealDelivered({ dealId: id, userId: SELLER });
    expect(await deals.autoCompleteServiceDeal(id)).toBe(false);

    await deals.requestServiceDealCancellation({ dealId: id, userId: BUYER, reason: 'r' });
    expect(await deals.autoCancelServiceDeal(id)).toBe(false);
    expect((await deal(id)).status).toBe('CancellationRequested');
  });
});

describe('cancellation requests', () => {
  const requested = async () => {
    const { id } = await request();
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    await deals.requestServiceDealCancellation({
      dealId: id,
      userId: BUYER,
      reason: 'changed my mind',
    });
    return id;
  };

  it('is answered only by the other party; agreeing refunds', async () => {
    const id = await requested();
    await expect(
      deals.respondServiceDealCancellation({ dealId: id, userId: BUYER, agree: true })
    ).rejects.toEqual(conflict);
    await deals.respondServiceDealCancellation({ dealId: id, userId: SELLER, agree: true });
    expect(await deal(id)).toMatchObject({
      status: 'Cancelled',
      closeReason: 'cancellation_agreed',
    });
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
  });

  it('goes to dispute when declined, with nothing refunded', async () => {
    const id = await requested();
    await deals.respondServiceDealCancellation({ dealId: id, userId: SELLER, agree: false });
    expect((await deal(id)).status).toBe('Disputed');
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('is granted after 48 hours unanswered, and not before', async () => {
    const id = await requested();
    await age(id, 'cancellationRequestedAt', 47);
    expect(await deals.autoCancelServiceDeals()).toMatchObject({ moved: 0 });
    await age(id, 'cancellationRequestedAt', 49);
    expect(await deals.autoCancelServiceDeals()).toMatchObject({ moved: 1 });
    expect(await deal(id)).toMatchObject({
      status: 'Cancelled',
      closeReason: 'cancellation_unanswered',
    });
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('open deals per offering', () => {
  it('counts only open deals, by the same definition the cap uses', async () => {
    const open = (await request()).id;
    const closed = (await request({ buyerId: STRANGER })).id;
    await deals.declineServiceDeal({ dealId: closed, userId: SELLER });
    expect(open).toBeDefined();
    expect(await deals.countOpenDealsByOffering([1, 2])).toEqual(new Map([[1, 1]]));
  });
});
