import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { SERVICES_TERMS_VERSION } from '~/shared/constants/creator-service-terms.constants';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as AccessLog from '~/server/services/creator-service-deal-file-access';
import type * as ChatService from '~/server/services/chat.service';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as CreatorShop from '~/server/services/creator-shop.service';
import type * as NotificationService from '~/server/services/notification.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The Creator Services deal state machine and its escrow, run against the real P0 migration on an
 * in-process Postgres. Only the Buzz service, the chat side effects and the lock are faked; every
 * claim, transition and receipt is the production SQL.
 */

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const buzz = vi.hoisted(() => ({
  createBuzzTransaction: vi.fn(),
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

const notifications = vi.hoisted(() => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  ...notifications,
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

const accessLog = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('~/server/services/creator-service-deal-file-access', async (importOriginal) => ({
  ...(await importOriginal<typeof AccessLog>()),
  readServiceDealFileAccess: async () => accessLog.value,
}));

const deals = await import('~/server/services/creator-service-deal.service');
const reviews = await import('~/server/services/creator-service-dispute-review.service');
const escrow = await import('~/server/services/creator-service-escrow.service');
const { creatorServiceNotifications } = await import(
  '~/server/notifications/creator-service.notifications'
);
const { MAX_LEG_ATTEMPTS } = await import('~/server/services/placement-escrow.service');
const { TransactionType } = await import('~/shared/constants/buzz.constants');

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261025120000_creator_services_foundation/migration.sql'
);
const FILE_STATE_MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261028140000_creator_service_deal_file_state/migration.sql'
);
const NSFW_MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261028150000_creator_service_max_nsfw_level/migration.sql'
);
const TAKEDOWN_MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261028170000_creator_service_offering_takedown/migration.sql'
);
const REASON_CODE_MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261028130000_service_deal_event_reason_code/migration.sql'
);

const LATER_MIGRATIONS = [
  '20261028160000_creator_service_deal_file_entries',
  '20261029140000_creator_service_deal_file_delivery',
  '20261128150000_creator_service_final_malware_scan',
  '20261208120000_creator_service_dispute_review',
].map((name) =>
  join(process.cwd(), `packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`)
);

const SELLER = 1;
const BUYER = 2;
const STRANGER = 3;
const PRICE = 500;
const PG = 1;
const PG13 = 2;
const R = 4;
const SFW_LEVELS = PG | PG13;
const ALL_LEVELS = 31;

/** The offering a faked Prisma read includes, as the real `include` always does. */
const OFFERING_ROW = { id: 1, title: 'Cat portraits', coverImageId: null, removedReason: null };

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
    expectedRevisionsIncluded: 1,
    expectedDeliveryDays: 3,
    buyerId: BUYER,
    requestText: 'please draw my cat',
    disclosureVersion: SERVICES_TERMS_VERSION,
    buzzType: 'yellow',
    // A buyer on the mature-capable domain who browses at PG only, as most do.
    servableLevels: ALL_LEVELS,
    consentLevels: PG,
    ...overrides,
  });

/**
 * Delivery without the file checks, which this suite does not exercise: production delivers through
 * `deliverServiceDeal` (the files suite), and nothing else may move a deal to Delivered.
 */
const markDelivered = (dealId: number) =>
  deals.transitionDeal({
    dealId,
    from: ['Accepted', 'InRevision'],
    to: 'Delivered',
    actorId: SELLER,
    event: 'Delivered',
    set: Prisma.sql`, "deliveredAt" = now()`,
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

/** A final for the deal's current round (or `round`), as the delivery seat's scanner leaves it. */
const finals = (id: number, scanStatus = 'Passed', round?: number, status = 'Ready') =>
  q(
    `INSERT INTO "ServiceDealFile" ("dealId", round, kind, "s3Key", "mimeType", size, "scanStatus", status)
     SELECT $1, COALESCE($3::int, "revisionsUsed"), 'Final', md5(random()::text), 'application/zip', 1,
       $2::"ServiceDealFileScanStatus", $4::"ServiceDealFileStatus"
     FROM "ServiceDeal" WHERE id = $1`,
    [id, scanStatus, round ?? null, status]
  );

/** Delivers with a final that passed scanning, as a completed deal needs. */
const deliver = async (id: number) => {
  await finals(id);
  await markDelivered(id);
};

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp, "deletedAt" timestamp, muted boolean NOT NULL DEFAULT false);
    CREATE TYPE "UserEngagementType" AS ENUM ('Hide', 'Follow', 'Block');
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type "UserEngagementType");
    CREATE TABLE "Report" (id serial PRIMARY KEY);
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
  await holder.db.exec(readFileSync(REASON_CODE_MIGRATION, 'utf8'));
  await holder.db.exec(readFileSync(FILE_STATE_MIGRATION, 'utf8'));
  await holder.db.exec(readFileSync(NSFW_MIGRATION, 'utf8'));
  await holder.db.exec(readFileSync(TAKEDOWN_MIGRATION, 'utf8'));
  for (const migration of LATER_MIGRATIONS) await holder.db.exec(readFileSync(migration, 'utf8'));
});

beforeEach(async () => {
  vi.clearAllMocks();
  accessLog.value = null;
  // clearAllMocks keeps a queued *Once; a test that fails early would leak it into the next.
  for (const fn of Object.values(buzz)) fn.mockReset();
  notifications.createNotification.mockReset();
  shop.assertCreatorShopVisible.mockReset();
  locks.available = true;
  locks.held.clear();
  buzz.createMultiAccountBuzzTransaction.mockResolvedValue(charged());
  buzz.createBuzzTransaction.mockResolvedValue({
    transactionId: 'tx-release',
    remainingBalance: null,
  });
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
    TRUNCATE "ServiceDisputeReview", "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal", "ServiceOfferingReport", "ServiceOffering", "UserEngagement" RESTART IDENTITY;
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

  it.each([
    ['an empty version', ''],
    ['a superseded version', 'services-terms-1999-01-01'],
  ])(
    'refuses a request sent with %s of the buyer disclosure, before any charge',
    async (_, disclosureVersion) => {
      await expect(request({ disclosureVersion })).rejects.toThrow(/Review the request terms/);
      expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
      expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    }
  );

  it('refuses a request at a price other than the one the buyer was shown', async () => {
    await q(`UPDATE "ServiceOffering" SET price = 50000`);
    await expect(request()).rejects.toEqual(conflict);
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['revisions', `"revisionsIncluded" = 4`],
    ['delivery days', `"deliveryDays" = 30`],
  ])('refuses a request whose %s changed since the buyer saw them', async (_, change) => {
    await q(`UPDATE "ServiceOffering" SET ${change}`);
    await expect(request()).rejects.toEqual(
      expect.objectContaining({ code: 'CONFLICT', message: expect.stringMatching(/terms/) })
    );
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  // The pre-check above answers with a message; the INSERT repeats each term as its own
  // precondition, so terms changing between the two cannot be copied into the deal.
  it.each([
    ['revisions', { expectedRevisionsIncluded: 4 }, `"revisionsIncluded" = 4`],
    ['delivery days', { expectedDeliveryDays: 30 }, `"deliveryDays" = 30`],
  ])(
    'creates no deal when the %s change between the check and the insert',
    async (_, expected, change) => {
      // The check passes against the buyer's terms, then the offering moves back before the INSERT.
      await q(`UPDATE "ServiceOffering" SET ${change}`);
      shop.assertCreatorShopVisible.mockImplementationOnce(async () => {
        await q(`UPDATE "ServiceOffering" SET "revisionsIncluded" = 1, "deliveryDays" = 3`);
        return [];
      });
      await expect(request(expected)).rejects.toEqual(conflict);
      expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
      expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    }
  );

  it('refuses a second unanswered request from the same buyer, so a doubled submit holds once', async () => {
    await request();
    await expect(request()).rejects.toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        message: expect.stringMatching(/already have a request waiting/),
      })
    );
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

  // The pre-check answers with a message; the INSERT's NOT EXISTS is what holds when two submits
  // both pass it. Here the pre-check is blinded (the offering read passes through) to stand in
  // for that race.
  it('still creates one deal and one hold when a second submit passes the pre-check', async () => {
    await request();
    dbMock.dbWrite.$queryRaw
      .mockImplementationOnce(((...a: Parameters<Raw['queryRaw']>) =>
        pgliteRaw(holder.db).queryRaw(...a)) as never)
      .mockImplementationOnce((async () => []) as never);
    await expect(request()).rejects.toEqual(conflict);
    expect(await q(`SELECT id FROM "ServiceDeal" WHERE "buyerId" = $1`, [BUYER])).toHaveLength(1);
    expect(buzz.createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(1);
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
        `creator-service-${id}-hold`,
        { timeoutMs: expect.any(Number) }
      );
      for (const call of buzz.getTransactionByExternalId.mock.calls)
        expect(call[1]).toEqual({ timeoutMs: expect.any(Number) });
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

    // More than was held under one hold's prefix (a second charge) is for a human, not a settle.
    it('stays refund-pending when the ledger lists more than was held', async () => {
      refunded('leg-a', 'leg-b', 'leg-c');
      buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
        ...holdLegs,
        { ...holdLegs[0], transactionId: 'leg-c', amount: 100 },
      ]);
      const { id } = await request();
      await deals.declineServiceDeal({ dealId: id, userId: SELLER });
      expect((await deal(id)).settledAt).toBeNull();
      expect((await refundLeg(id))?.lastError).toMatch(/ledger lists 600 of 500/);
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
    await deliver(id);
    await deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'tweak' });
    await q(`UPDATE "ServiceDeal" SET "dueAt" = now() - interval '5 days' WHERE id = $1`, [id]);
    await expect(deals.cancelLateServiceDeal({ dealId: id, userId: BUYER })).rejects.toEqual(
      conflict
    );
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('counts revisions against the snapshot and completes with a 48h dispute window', async () => {
    const id = await accepted();
    await deliver(id);
    await deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'bigger ears' });
    await deliver(id);
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
    await deliver(id);
    await age(id, 'deliveredAt', 71);
    expect(await deals.autoCompleteServiceDeals()).toMatchObject({ moved: 0 });
    await age(id, 'deliveredAt', 73);
    expect(await deals.autoCompleteServiceDeals()).toMatchObject({ moved: 1 });
    expect((await deal(id)).status).toBe('Completed');
  });

  it('opens a dispute inside the window only', async () => {
    const id = await accepted();
    await deliver(id);
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
    await deliver(id);
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

describe('releasing to the seller', () => {
  const completed = async (overrides: Parameters<typeof request>[0] = {}) => {
    const { id } = await request(overrides);
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    await deliver(id);
    await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
    return id;
  };
  const windowClosed = (id: number) =>
    q(`UPDATE "ServiceDeal" SET "releaseAt" = now() - interval '1 minute' WHERE id = $1`, [id]);
  const releaseLeg = async (id: number) => (await legs(id)).find((l) => l.leg === 'Release');
  const ledgerShows = (toAccountId: number, amount: number) =>
    buzz.getTransactionByExternalId.mockResolvedValue({
      date: new Date(),
      type: TransactionType.ServiceEscrow,
      fromAccountId: 0,
      toAccountId,
      amount,
    });

  it('pays the seller the held amount once the dispute window closes, once, and settles', async () => {
    const id = await completed();
    await windowClosed(id);
    expect(await escrow.sweepServiceDealReleases()).toEqual({ considered: 1, released: 1 });

    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.createBuzzTransaction.mock.calls[0][0]).toEqual({
      amount: PRICE,
      fromAccountId: 0,
      fromAccountType: 'yellow',
      toAccountId: SELLER,
      toAccountType: 'yellow',
      type: TransactionType.ServiceEscrow,
      externalTransactionId: `creator-service-${id}-release`,
      description: 'Creator service: released to the seller',
      // The bankable ledger nets the release against this buyer, and leaves a release without it out.
      details: {
        entityType: 'ServiceDeal',
        entityId: id,
        buyerId: BUYER,
        heldAt: Math.floor((await deal(id)).heldAt!.getTime() / 1000),
      },
    });
    expect(await releaseLeg(id)).toMatchObject({ amount: PRICE, transactionId: 'tx-release' });
    const settled = await deal(id);
    expect(settled.status).toBe('Completed');
    expect(settled.settledAt).not.toBeNull();
    expect(await events(id)).toContain('Released');

    expect(await escrow.sweepServiceDealReleases()).toEqual({ considered: 0, released: 0 });
    expect(await escrow.releaseDeal(id)).toBe(true);
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
  });

  it('pays nothing while the dispute window is open', async () => {
    const id = await completed();
    expect(await escrow.sweepServiceDealReleases()).toEqual({ considered: 0, released: 0 });
    expect(await escrow.releaseDeal(id)).toBe(false);
    expect(await releaseLeg(id)).toBeUndefined();
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
  });

  // The reverse order of the dispute/release race: the dispute commits first, so the claim's own
  // re-check finds the deal no longer Completed and claims nothing.
  it('claims nothing for a deal disputed before its window closed', async () => {
    const id = await completed();
    await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'zip is empty' });
    await windowClosed(id);
    expect(await escrow.releaseDeal(id)).toBe(false);
    expect(await releaseLeg(id)).toBeUndefined();
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
  });

  // Decision: a dispute's window guard reads clock_timestamp(). A dispute blocked behind a
  // release claim's row lock is re-checked after that claim commits, and now() would still be the
  // dispute transaction's start, inside the window, letting it through over a claimed payout.
  // PGlite runs one connection, so the lock wait cannot be reproduced here: this pins the text.
  // Keep it unless the claim and the dispute are serialised some other way.
  it('decision: a dispute re-checks its window against clock_timestamp(), not now()', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/server/services/creator-service-deal.service.ts'),
      'utf8'
    );
    const dispute = source.slice(source.indexOf('export const openServiceDealDispute'));
    const guard = dispute.slice(0, dispute.indexOf('});'));
    expect(guard).toContain('"releaseAt" > clock_timestamp()');
    expect(guard).not.toContain('"releaseAt" > now()');
  });

  it.each([
    ['banned', `"bannedAt" = now()`],
    ['deleted', `"deletedAt" = now()`],
  ])("holds a %s seller's payout for the moderators: no release, no refund", async (_, column) => {
    const id = await completed();
    await windowClosed(id);
    await q(`UPDATE "User" SET ${column} WHERE id = $1`, [SELLER]);
    expect(await escrow.sweepServiceDealReleases()).toEqual({ considered: 1, released: 0 });

    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(await releaseLeg(id)).toBeUndefined();
    const held = await deal(id);
    expect(held).toMatchObject({ status: 'Disputed', settledAt: null });
    expect(
      (
        await q<{ disputeReason: string }>(
          `SELECT "disputeReason" FROM "ServiceDeal" WHERE id = $1`,
          [id]
        )
      )[0]
    ).toEqual({ disputeReason: escrow.SELLER_UNAVAILABLE });
    expect((await events(id)).at(-1)).toBe('Disputed');
    expect(await escrow.sweepServiceDealReleases()).toEqual({ considered: 0, released: 0 });
    expect(await escrow.releaseDeal(id)).toBe(false);
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
  });

  // Decision (briony, 2026-10-15): a claimed Release leg retries to completion, even for a seller
  // banned after the claim. It may already have landed; un-claiming it could pay twice. The hold
  // applies only before a claim exists. A moderator is told through the log.
  it('decision: a release claimed before the seller was banned still pays, and is logged', async () => {
    const id = await completed();
    await windowClosed(id);
    buzz.createBuzzTransaction.mockRejectedValueOnce(buzzError(503));
    await expect(escrow.releaseDeal(id)).rejects.toThrow();
    expect(await releaseLeg(id)).toMatchObject({ transactionId: null, attempts: 1 });

    await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [SELLER]);
    // Inside the backoff: nothing is paid, and the deal is not moved under its claimed leg.
    expect(await escrow.sweepServiceDealReleases()).toEqual({ considered: 1, released: 0 });
    expect((await deal(id)).status).toBe('Completed');
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);

    await q(
      `UPDATE "ServiceDealTransaction" SET "lastAttemptAt" = now() - interval '1 day' WHERE leg = 'Release'`
    );
    expect(await escrow.sweepServiceDealReleases()).toEqual({ considered: 1, released: 1 });
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(2);
    expect(buzz.createBuzzTransaction.mock.calls[1][0]).toMatchObject({ toAccountId: SELLER });
    const paid = await deal(id);
    expect(paid.status).toBe('Completed');
    expect(paid.settledAt).not.toBeNull();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'claimed release paying a seller who is now banned or deleted',
        dealId: id,
      })
    );
  });

  it('pays a muted seller', async () => {
    const id = await completed();
    await windowClosed(id);
    await q(`UPDATE "User" SET muted = true WHERE id = $1`, [SELLER]);
    expect(await escrow.releaseDeal(id)).toBe(true);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ dealId: id, type: 'warning' })
    );
    expect(buzz.createBuzzTransaction.mock.calls[0][0]).toMatchObject({ toAccountId: SELLER });
    expect((await deal(id)).status).toBe('Completed');
  });

  it('pays a green deal in green, from and to', async () => {
    const id = await completed({ buzzType: 'green' });
    await windowClosed(id);
    expect(await escrow.releaseDeal(id)).toBe(true);
    expect(buzz.createBuzzTransaction.mock.calls[0][0]).toMatchObject({
      fromAccountType: 'green',
      toAccountType: 'green',
    });
  });

  // Decision, the claim's half of the dispute race: the claim LOCKS the deal row with an UPDATE
  // gated on the release state before it inserts the leg. An INSERT..SELECT alone reads a snapshot
  // and locks nothing, so a dispute could commit beside a claimed payout. PGlite cannot reproduce
  // that interleaving, so this pins the text. Keep it unless the two are serialised another way.
  it('decision: the release claim locks the deal row before it inserts the leg', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/server/services/creator-service-escrow.service.ts'),
      'utf8'
    );
    const start = source.indexOf('export async function claimRelease');
    const claim = source.slice(start, source.indexOf('\n}\n', start));
    const first = claim.indexOf('await lockDeal(tx, dealId);');
    const gate = claim.indexOf('const releasable = Prisma.sql');
    expect(first).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(first);
    const lock = claim.indexOf('UPDATE "ServiceDeal" SET "updatedAt" = now() WHERE ${releasable}');
    const insert = claim.indexOf('INSERT INTO "ServiceDealTransaction"');
    expect(gate).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(gate);
    expect(insert).toBeGreaterThan(lock);
    expect(claim.slice(gate, lock)).toContain(`"status" = 'Completed'`);
    expect(claim.slice(gate, lock)).toContain('"releaseAt" <= now()');
    expect(claim.slice(lock, insert)).toContain('if (locked === 0) return false;');
  });

  it('pays the receipted hold less the fee', async () => {
    const id = await completed();
    await q(`UPDATE "ServiceDeal" SET "feeAmount" = 100 WHERE id = $1`, [id]);
    await windowClosed(id);
    await escrow.releaseDeal(id);
    expect(buzz.createBuzzTransaction.mock.calls[0][0]).toMatchObject({ amount: PRICE - 100 });
    expect(await releaseLeg(id)).toMatchObject({ amount: PRICE - 100 });
  });

  it('claims nothing for a deal already settled', async () => {
    const id = await completed();
    await windowClosed(id);
    await q(`UPDATE "ServiceDeal" SET "settledAt" = now() WHERE id = $1`, [id]);
    expect(await escrow.releaseDeal(id)).toBe(false);
    expect(await releaseLeg(id)).toBeUndefined();
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
  });

  // The claim's `heldAt IS NOT NULL` cannot be reached on its own: the schema refuses a Completed
  // deal without it, and the receipted-hold join is the claim's second layer. This pins the first.
  it('cannot hold a Completed deal that was never marked held', async () => {
    const id = await completed();
    await expect(q(`UPDATE "ServiceDeal" SET "heldAt" = NULL WHERE id = $1`, [id])).rejects.toThrow(
      /ServiceDeal_held_before_work/
    );
  });

  it('never releases a hold with no receipt', async () => {
    const id = await completed();
    await q(
      `UPDATE "ServiceDealTransaction" SET "transactionId" = NULL WHERE "dealId" = $1 AND leg = 'Hold'`,
      [id]
    );
    await windowClosed(id);
    expect(await escrow.releaseDeal(id)).toBe(false);
    expect(await releaseLeg(id)).toBeUndefined();
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
  });

  it('raises when a Refund already holds the payout slot, rather than treating it as claimed', async () => {
    const id = await completed();
    await windowClosed(id);
    await q(
      `INSERT INTO "ServiceDealTransaction" ("dealId", leg, "externalTransactionId", amount, "buzzType")
       VALUES ($1, 'Refund', 'r', $2, 'yellow')`,
      [id, PRICE]
    );
    await expect(escrow.releaseDeal(id)).rejects.toThrow(
      /ServiceDealTransaction_dealId_payout_key/
    );
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
  });

  it('receipts a 409 only when the ledger shows the release reached this seller in full', async () => {
    const id = await completed();
    await windowClosed(id);
    buzz.createBuzzTransaction.mockRejectedValue(buzzError(409));
    ledgerShows(SELLER, PRICE);
    expect(await escrow.releaseDeal(id)).toBe(true);
    expect(buzz.getTransactionByExternalId).toHaveBeenCalledWith(`creator-service-${id}-release`, {
      timeoutMs: expect.any(Number),
    });
    expect(await releaseLeg(id)).toMatchObject({ transactionId: `creator-service-${id}-release` });
    expect((await deal(id)).settledAt).not.toBeNull();
  });

  it.each([
    ['another account', () => ledgerShows(STRANGER, PRICE)],
    ['a different amount', () => ledgerShows(SELLER, PRICE - 1)],
    ['nothing', () => buzz.getTransactionByExternalId.mockResolvedValue(null)],
  ])('leaves a 409 pending when the ledger shows %s', async (_, ledger) => {
    const id = await completed();
    await windowClosed(id);
    buzz.createBuzzTransaction.mockRejectedValue(buzzError(409));
    ledger();
    await expect(escrow.releaseDeal(id)).rejects.toThrow(/not confirmed on the ledger/);
    expect(await releaseLeg(id)).toMatchObject({ transactionId: null, attempts: 1 });
    expect((await deal(id)).settledAt).toBeNull();
  });

  it('checks the ledger when Buzz reports success without a transaction id', async () => {
    const id = await completed();
    await windowClosed(id);
    buzz.createBuzzTransaction.mockResolvedValue({ transactionId: null, remainingBalance: null });
    buzz.getTransactionByExternalId.mockResolvedValue(null);
    await expect(escrow.releaseDeal(id)).rejects.toThrow(/not confirmed on the ledger/);
    expect((await deal(id)).settledAt).toBeNull();

    ledgerShows(SELLER, PRICE);
    await q(
      `UPDATE "ServiceDealTransaction" SET "lastAttemptAt" = now() - interval '1 day' WHERE leg = 'Release'`
    );
    expect(await escrow.releaseDeal(id)).toBe(true);
    expect((await deal(id)).settledAt).not.toBeNull();
  });

  it('retries a failed release after backoff, stops at the ceiling, and counts it as exhausted', async () => {
    const id = await completed();
    await windowClosed(id);
    buzz.createBuzzTransaction.mockRejectedValue(buzzError(503));
    await escrow.sweepServiceDealReleases();
    expect(await releaseLeg(id)).toMatchObject({ attempts: 1, transactionId: null });

    await escrow.sweepServiceDealReleases();
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);

    for (let attempt = 2; attempt <= MAX_LEG_ATTEMPTS + 2; attempt++) {
      await q(
        `UPDATE "ServiceDealTransaction" SET "lastAttemptAt" = now() - interval '1 day' WHERE leg = 'Release'`
      );
      await escrow.sweepServiceDealReleases();
    }
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(MAX_LEG_ATTEMPTS);
    expect(await escrow.sweepServiceDealReleases()).toEqual({ considered: 0, released: 0 });
    expect(await escrow.sweepServiceDealRefunds()).toMatchObject({ exhausted: 1 });
    expect((await deal(id)).settledAt).toBeNull();
  });
});

describe('the finals gate and dispute resolution', () => {
  const delivered = async (overrides: Parameters<typeof request>[0] = {}) => {
    const { id } = await request(overrides);
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    await markDelivered(id);
    return id;
  };
  const completed = async () => {
    const id = await delivered();
    await finals(id);
    await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
    return id;
  };
  const windowClosed = (id: number) =>
    q(`UPDATE "ServiceDeal" SET "releaseAt" = now() - interval '1 minute' WHERE id = $1`, [id]);
  const scan = (id: number, status: string) =>
    q(
      `UPDATE "ServiceDealFile" SET "scanStatus" = $2::"ServiceDealFileScanStatus" WHERE "dealId" = $1`,
      [id, status]
    );
  const resolve = (id: number, resolution: 'Refund' | 'Release') =>
    deals.resolveServiceDealDispute({ dealId: id, moderatorId: STRANGER, resolution, note: 'n' });
  const disputeRow = async (id: number) =>
    (
      await q<{
        disputeResolution: string | null;
        disputeResolvedById: number | null;
        disputeReason: string | null;
      }>(
        `SELECT "disputeResolution"::text, "disputeResolvedById", "disputeReason" FROM "ServiceDeal" WHERE id = $1`,
        [id]
      )
    )[0];

  it.each([
    ['no final at all', async () => undefined],
    ['a final still being scanned', (id: number) => finals(id, 'Pending')],
    ['a final that failed scanning', (id: number) => finals(id, 'Failed')],
    [
      'a passed final beside a pending one',
      async (id: number) => {
        await finals(id);
        await finals(id, 'Pending');
      },
    ],
    // Only a Ready final counts, and one that is not Ready blocks, as delivery treats them.
    ...(['Uploading', 'Failed'] as const).map(
      (status) =>
        [
          `a passed final that is ${status}`,
          (id: number) => finals(id, 'Passed', undefined, status),
        ] as const
    ),
    [
      'a passed Ready final beside a passed one still uploading',
      async (id: number) => {
        await finals(id);
        await finals(id, 'Passed', undefined, 'Uploading');
      },
    ],
    [
      'a passed final from an earlier round only',
      async (id: number) => {
        await finals(id, 'Passed', 0);
        await q(`UPDATE "ServiceDeal" SET "revisionsUsed" = 1 WHERE id = $1`, [id]);
      },
    ],
  ])('will not complete a delivery with %s', async (_, setUp) => {
    const id = await delivered();
    await setUp(id);
    await expect(deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER })).rejects.toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        message: expect.stringMatching(/still being checked/),
      })
    );
    await age(id, 'deliveredAt', 24 * 4);
    expect(await deals.autoCompleteServiceDeal(id)).toBe(false);
    expect((await deal(id)).status).toBe('Delivered');
  });

  it('auto-completes on the first sweep after the finals clear, even past three days', async () => {
    const id = await delivered();
    await finals(id, 'Pending');
    await age(id, 'deliveredAt', 24 * 5);
    expect(await deals.autoCompleteServiceDeals()).toMatchObject({ moved: 0 });
    await scan(id, 'Passed');
    expect(await deals.autoCompleteServiceDeals()).toMatchObject({ moved: 1 });
    const row = await deal(id);
    expect(row.status).toBe('Completed');
    expect(row.releaseAt!.getTime() - row.completedAt!.getTime()).toBe(48 * 3_600_000);
  });

  it('holds a release whose finals stopped passing, and pays nothing', async () => {
    const id = await completed();
    await windowClosed(id);
    await scan(id, 'Failed');
    expect(await escrow.sweepServiceDealReleases()).toEqual({ considered: 1, released: 0 });
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    expect((await deal(id)).status).toBe('Disputed');
    expect((await disputeRow(id)).disputeReason).toBe(escrow.FINAL_SCAN_FAILED);
  });

  it('sends a delivered deal to the moderators, but never one whose payout is claimed', async () => {
    const id = await delivered();
    expect(await escrow.holdServiceDealForReview(id, escrow.FINAL_SCAN_FAILED)).toBe(true);
    expect((await deal(id)).status).toBe('Disputed');
    expect((await events(id)).at(-1)).toBe('Disputed');

    const paid = await completed();
    await windowClosed(paid);
    buzz.createBuzzTransaction.mockRejectedValueOnce(buzzError(503));
    await expect(escrow.releaseDeal(paid)).rejects.toThrow();
    expect(await escrow.holdServiceDealForReview(paid, escrow.FINAL_SCAN_FAILED)).toBe(false);
    expect((await deal(paid)).status).toBe('Completed');
  });

  // Every road into Disputed, each refunded by a moderator exactly once.
  it.each([
    [
      'a buyer dispute',
      async () => {
        const id = await completed();
        await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'broken zip' });
        return id;
      },
    ],
    [
      'a declined cancellation',
      async () => {
        const id = await delivered();
        await deals.requestServiceDealCancellation({ dealId: id, userId: BUYER, reason: 'r' });
        await deals.respondServiceDealCancellation({ dealId: id, userId: SELLER, agree: false });
        return id;
      },
    ],
    [
      'a failed final',
      async () => {
        const id = await delivered();
        await escrow.holdServiceDealForReview(id, escrow.FINAL_SCAN_FAILED);
        return id;
      },
    ],
    [
      'an unavailable seller',
      async () => {
        const id = await completed();
        await windowClosed(id);
        await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [SELLER]);
        await escrow.sweepServiceDealReleases();
        return id;
      },
    ],
  ])('refunds %s once, and answers a repeat as already resolved', async (_, open) => {
    const id = await open();
    expect((await deal(id)).status).toBe('Disputed');
    expect(await resolve(id, 'Refund')).toEqual({ status: 'resolved', resolution: 'Refund' });
    const row = await deal(id);
    expect(row).toMatchObject({ status: 'Cancelled', closeReason: 'dispute_refund' });
    expect(row.settledAt).not.toBeNull();
    expect(await disputeRow(id)).toMatchObject({
      disputeResolution: 'Refund',
      disputeResolvedById: STRANGER,
    });
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);

    expect(await resolve(id, 'Refund')).toEqual({
      status: 'already-resolved',
      resolution: 'Refund',
    });
    expect(await resolve(id, 'Release')).toEqual({
      status: 'already-resolved',
      resolution: 'Refund',
    });
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
  });

  it('releases a held seller once a moderator decides so, and only once', async () => {
    const id = await completed();
    await windowClosed(id);
    await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [SELLER]);
    await escrow.sweepServiceDealReleases();
    expect((await disputeRow(id)).disputeReason).toBe(escrow.SELLER_UNAVAILABLE);

    expect(await resolve(id, 'Release')).toEqual({ status: 'resolved', resolution: 'Release' });
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.createBuzzTransaction.mock.calls[0][0]).toMatchObject({
      toAccountId: SELLER,
      amount: PRICE,
    });
    const row = await deal(id);
    expect(row.status).toBe('Completed');
    expect(row.settledAt).not.toBeNull();

    expect(await resolve(id, 'Release')).toEqual({
      status: 'already-resolved',
      resolution: 'Release',
    });
    await escrow.sweepServiceDealReleases();
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['seller', SELLER, 'Release'],
    ['buyer', BUYER, 'Refund'],
  ] as const)(
    'refuses a moderator who is the %s, and moves nothing',
    async (_, moderatorId, resolution) => {
      const id = await completed();
      await finals(id);
      await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'not as previewed' });
      await expect(
        deals.resolveServiceDealDispute({ dealId: id, moderatorId, resolution })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringMatching(/Another moderator/),
      });
      expect((await deal(id)).status).toBe('Disputed');
      expect((await disputeRow(id)).disputeResolution).toBeNull();
      expect(await events(id)).not.toContain('DisputeResolved');
      expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
      expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
    }
  );

  // A party learns nothing either: not an earlier ruling, nor that the finals block a Release.
  it.each([
    [
      'already resolved',
      async (id: number) => {
        await finals(id);
        await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'r' });
        await resolve(id, 'Refund');
      },
    ],
    [
      'whose finals have not passed',
      async (id: number) => {
        await finals(id, 'Pending');
        await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'r' });
      },
    ],
  ])('refuses the seller as moderator on a deal %s', async (_, setup) => {
    const id = await completed();
    await setup(id);
    await expect(
      deals.resolveServiceDealDispute({ dealId: id, moderatorId: SELLER, resolution: 'Release' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
  });

  it('releases a buyer dispute decided for the seller', async () => {
    const id = await completed();
    await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'not as previewed' });
    expect(await resolve(id, 'Release')).toEqual({ status: 'resolved', resolution: 'Release' });
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect((await deal(id)).settledAt).not.toBeNull();
  });

  it('refuses to release for finals that did not pass scanning, and moves nothing', async () => {
    const id = await delivered();
    await finals(id, 'Failed');
    await escrow.holdServiceDealForReview(id, escrow.FINAL_SCAN_FAILED);
    expect(await resolve(id, 'Release')).toEqual({
      status: 'refused',
      reason: 'finals_not_passed',
      message: expect.stringMatching(/passed scanning/),
    });
    expect((await deal(id)).status).toBe('Disputed');
    expect((await disputeRow(id)).disputeResolution).toBeNull();
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    expect(await events(id)).not.toContain('DisputeResolved');
  });

  it('refuses to release for a final that passed scanning but is not Ready', async () => {
    const id = await delivered();
    await finals(id, 'Passed', undefined, 'Failed');
    await escrow.holdServiceDealForReview(id, escrow.FINAL_SCAN_FAILED);
    expect(await resolve(id, 'Release')).toMatchObject({
      status: 'refused',
      reason: 'finals_not_passed',
    });
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    expect((await deal(id)).status).toBe('Disputed');
  });

  // A crash between the resolution and the payment must leave the refund claimed for the sweep.
  it('claims the refund in the same transaction that resolves the dispute', async () => {
    buzz.refundMultiAccountTransaction.mockRejectedValue(buzzError(503));
    const id = await completed();
    await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'r' });
    await resolve(id, 'Refund');
    const [row] = await q<{ same: boolean }>(
      `SELECT t."createdAt" = d."closedAt" AS same FROM "ServiceDealTransaction" t
       JOIN "ServiceDeal" d ON d.id = t."dealId" WHERE t."dealId" = $1 AND t.leg = 'Refund'`,
      [id]
    );
    expect(row).toEqual({ same: true });
  });

  it.each([
    ['banned', `"bannedAt" = now()`],
    ['deleted', `"deletedAt" = now()`],
  ])(
    'holds a released deal again for a seller %s after the moderator decided',
    async (_, column) => {
      const id = await completed();
      await q(
        `UPDATE "ServiceDeal" SET "releaseAt" = now() - interval '1 minute',
       "disputeResolution" = 'Release', "disputeResolvedAt" = now() - interval '1 minute',
       "disputeResolvedById" = $2 WHERE id = $1`,
        [id, STRANGER]
      );
      await q(`UPDATE "User" SET ${column} WHERE id = $1`, [SELLER]);
      expect(await escrow.sweepServiceDealReleases()).toEqual({ considered: 1, released: 0 });
      expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
      expect(await disputeRow(id)).toMatchObject({
        disputeReason: escrow.SELLER_UNAVAILABLE,
        disputeResolution: null,
      });
    }
  );

  // A claimed Release leg always completes, whatever happens to the finals afterwards.
  it('never re-holds a release whose leg is already claimed when a final fails', async () => {
    const id = await completed();
    await windowClosed(id);
    buzz.createBuzzTransaction.mockRejectedValueOnce(buzzError(503));
    await expect(escrow.releaseDeal(id)).rejects.toThrow();
    await scan(id, 'Failed');
    await q(
      `UPDATE "ServiceDealTransaction" SET "lastAttemptAt" = now() - interval '1 day' WHERE leg = 'Release'`
    );
    expect(await escrow.sweepServiceDealReleases()).toEqual({ considered: 1, released: 1 });
    expect((await deal(id)).status).toBe('Completed');
  });

  it('tells the moderator when the payout claim holds a released deal again', async () => {
    const id = await completed();
    await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'r' });
    // A final flips inside the resolving transaction, after its own check: the claim catches it.
    await holder.db.exec(`
      CREATE FUNCTION flip_final() RETURNS trigger AS $$ BEGIN
        UPDATE "ServiceDealFile" SET "scanStatus" = 'Failed' WHERE "dealId" = NEW."dealId";
        RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER flip_final AFTER INSERT ON "ServiceDealEvent"
        FOR EACH ROW WHEN (NEW.type = 'DisputeResolved') EXECUTE FUNCTION flip_final();
    `);
    try {
      expect(await resolve(id, 'Release')).toEqual({
        status: 'held-for-review',
        reason: escrow.FINAL_SCAN_FAILED,
      });
      expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    } finally {
      await holder.db.exec(
        `DROP TRIGGER flip_final ON "ServiceDealEvent"; DROP FUNCTION flip_final();`
      );
    }
  });

  // The parties' view of a held deal: no hold reason, no moderator id. Moderators see both.
  it("keeps hold reasons and moderator ids out of the parties' view of a deal", async () => {
    const at = new Date();
    const held = {
      id: 9,
      offering: OFFERING_ROW,
      buyerId: BUYER,
      sellerId: SELLER,
      status: 'Disputed',
      disputeOpenedAt: at,
      disputeReason: escrow.SELLER_UNAVAILABLE,
      events: [
        {
          id: 1,
          type: 'Disputed',
          actorId: -1,
          round: 0,
          comment: escrow.SELLER_UNAVAILABLE,
          createdAt: at,
        },
        {
          id: 2,
          type: 'DisputeResolved',
          actorId: STRANGER,
          round: 0,
          comment: 'n',
          createdAt: at,
        },
      ],
    };
    (
      dbMock.dbWrite as unknown as { serviceDeal: { findUnique: ReturnType<typeof vi.fn> } }
    ).serviceDeal.findUnique = vi.fn().mockResolvedValue(held);

    const buyer = await deals.getServiceDealView({
      dealId: 9,
      userId: BUYER,
      servicesEnabled: true,
    });
    expect(buyer.dispute?.reason).toBeNull();
    expect(buyer.events.map((e) => [e.actorId, e.comment])).toEqual([
      [null, null],
      [null, 'n'],
    ]);

    const moderator = await deals.getServiceDealView({
      dealId: 9,
      userId: STRANGER,
      isModerator: true,
      servicesEnabled: true,
    });
    expect(moderator.dispute?.reason).toBe(escrow.SELLER_UNAVAILABLE);
    expect(moderator.events[0].comment).toBe(escrow.SELLER_UNAVAILABLE);
  });

  it('answers CONFLICT for a deal that is not in dispute', async () => {
    const id = await delivered();
    await expect(resolve(id, 'Refund')).rejects.toEqual(conflict);
    expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('lets a moderator decide again when a released deal is held after the decision', async () => {
    const id = await completed();
    await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'r' });
    // Released by a moderator, then a final flips before the claim: the backstop holds it again.
    await q(
      `UPDATE "ServiceDeal" SET status = 'Completed', "releaseAt" = now() - interval '1 minute',
       "disputeResolution" = 'Release', "disputeResolvedAt" = now(), "disputeResolvedById" = $2 WHERE id = $1`,
      [id, STRANGER]
    );
    await scan(id, 'Failed');
    await escrow.sweepServiceDealReleases();
    expect((await deal(id)).status).toBe('Disputed');
    expect(await disputeRow(id)).toMatchObject({
      disputeReason: escrow.FINAL_SCAN_FAILED,
      disputeResolution: null,
    });
    expect(await resolve(id, 'Refund')).toEqual({ status: 'resolved', resolution: 'Refund' });
  });

  it('pages the queue by how long each dispute has waited, not by deal age', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await delivered();
      await escrow.holdServiceDealForReview(id, escrow.FINAL_SCAN_FAILED);
      ids.push(id);
      // Each new request needs the previous one answered: one open request per buyer per offering.
    }
    // The newest deal has waited longest; two share a dispute time, so the id breaks the tie.
    await q(
      `UPDATE "ServiceDeal" SET "disputeOpenedAt" = now() - interval '3 hours' WHERE id = $1`,
      [ids[2]]
    );
    await q(
      `UPDATE "ServiceDeal" SET "disputeOpenedAt" = now() - interval '1 hour' WHERE id = ANY($1)`,
      [[ids[0], ids[1]]]
    );
    const first = await deals.listDisputedServiceDeals({ limit: 2, viewerId: STRANGER });
    expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[0]]);
    const second = await deals.listDisputedServiceDeals({
      limit: 2,
      cursor: first.nextCursor,
      viewerId: STRANGER,
    });
    expect(second.items.map((item) => item.id)).toEqual([ids[1]]);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      deals.listDisputedServiceDeals({ cursor: 'nope', viewerId: STRANGER })
    ).rejects.toThrow(/cursor/);
  });

  it('lists the queue with what a decision needs', async () => {
    const held = await delivered();
    await finals(held, 'Failed');
    await escrow.holdServiceDealForReview(held, escrow.FINAL_SCAN_FAILED);
    const { items, nextCursor } = await deals.listDisputedServiceDeals({
      limit: 20,
      viewerId: STRANGER,
    });
    expect(nextCursor).toBeUndefined();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: held,
      disputeReason: escrow.FINAL_SCAN_FAILED,
      finalsClear: false,
      price: PRICE,
      seller: { id: SELLER, unavailable: false },
    });
    expect(items[0].events.at(-1)).toMatchObject({ type: 'Disputed' });
  });
});

// Decisions (briony, 2026-10-15): a muted party is never refused for being muted, only silenced.
// Their free text is dropped (never scanned, never stored), any code is kept, and an action that
// needs a reason gets `other`. The mute is read from the User row inside the transition.
const { throwOnBlockedUserContent } = await import('~/server/services/blocklist.service');

describe('reasons and reason codes', () => {
  const scan = vi.mocked(throwOnBlockedUserContent);

  const mute = (id: number, muted = true) =>
    q(`UPDATE "User" SET muted = $2 WHERE id = $1`, [id, muted]);
  /** The latest event a party made, past the system's own (a refund follows a decline). */
  const lastEvent = async (id: number) =>
    (
      await q<{ type: string; comment: string | null; reasonCode: string | null }>(
        `SELECT type::text, comment, "reasonCode" FROM "ServiceDealEvent"
         WHERE "dealId" = $1 AND "actorId" <> -1 ORDER BY id DESC LIMIT 1`,
        [id]
      )
    )[0];
  const reasons = async (id: number) =>
    (
      await q<{ cancellationReason: string | null; disputeReason: string | null }>(
        `SELECT "cancellationReason", "disputeReason" FROM "ServiceDeal" WHERE id = $1`,
        [id]
      )
    )[0];
  const accepted = async () => {
    const { id } = await request();
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    return id;
  };
  const completed = async () => {
    const id = await accepted();
    await deliver(id);
    await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
    return id;
  };

  it("stores an unmuted party's text and code, scanning the text", async () => {
    const id = await accepted();
    await deals.requestServiceDealCancellation({
      dealId: id,
      userId: BUYER,
      reason: 'it is late',
      reasonCode: 'not_delivered',
    });
    expect(await lastEvent(id)).toEqual({
      type: 'CancellationRequested',
      comment: 'it is late',
      reasonCode: 'not_delivered',
    });
    expect((await reasons(id)).cancellationReason).toBe('it is late');
    expect(scan).toHaveBeenCalledWith('it is late', expect.anything());
  });

  it("refuses an unmuted party's text the scan refuses, and moves nothing", async () => {
    const id = await accepted();
    scan.mockRejectedValueOnce(new Error('blocked'));
    await expect(
      deals.requestServiceDealCancellation({ dealId: id, userId: BUYER, reason: 'bad words' })
    ).rejects.toThrow('blocked');
    expect((await deal(id)).status).toBe('Accepted');
  });

  it("scans and keeps an unmuted seller's decline text", async () => {
    const { id } = await request();
    scan.mockClear();
    await deals.declineServiceDeal({ dealId: id, userId: SELLER, reason: 'fully booked' });
    expect(await lastEvent(id)).toEqual({
      type: 'Declined',
      comment: 'fully booked',
      reasonCode: null,
    });
    expect(scan).toHaveBeenCalledWith('fully booked', expect.anything());
  });

  it('takes a code without text', async () => {
    const { id } = await request();
    await deals.declineServiceDeal({ dealId: id, userId: SELLER, reasonCode: 'too_busy' });
    expect(await lastEvent(id)).toEqual({
      type: 'Declined',
      comment: null,
      reasonCode: 'too_busy',
    });
  });

  it.each([
    ['requestCancellation', () => accepted(), 'Accepted'],
    ['openDispute', () => completed(), 'Completed'],
  ] as const)('%s refuses no text and no code, and moves nothing', async (action, make, status) => {
    const id = await make();
    const leave =
      action === 'openDispute'
        ? deals.openServiceDealDispute({ dealId: id, userId: BUYER })
        : deals.requestServiceDealCancellation({ dealId: id, userId: BUYER });
    await expect(leave).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await deal(id)).status).toBe(status);
  });

  it("drops a muted party's cancellation text unscanned and records `other`", async () => {
    const id = await accepted();
    await mute(BUYER);
    scan.mockClear();
    await deals.requestServiceDealCancellation({ dealId: id, userId: BUYER, reason: 'bad words' });
    expect((await deal(id)).status).toBe('CancellationRequested');
    expect(await lastEvent(id)).toEqual({
      type: 'CancellationRequested',
      comment: null,
      reasonCode: 'other',
    });
    expect((await reasons(id)).cancellationReason).toBeNull();
    expect(scan).not.toHaveBeenCalled();
  });

  it("keeps a muted party's own code", async () => {
    const id = await accepted();
    await mute(SELLER);
    await deals.requestServiceDealCancellation({
      dealId: id,
      userId: SELLER,
      reason: 'x',
      reasonCode: 'buyer_unresponsive',
    });
    expect(await lastEvent(id)).toMatchObject({ comment: null, reasonCode: 'buyer_unresponsive' });
  });

  it("drops a muted buyer's dispute text from the event and the deal", async () => {
    const id = await completed();
    await mute(BUYER);
    await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'broken' });
    expect((await deal(id)).status).toBe('Disputed');
    expect(await lastEvent(id)).toEqual({ type: 'Disputed', comment: null, reasonCode: 'other' });
    expect((await reasons(id)).disputeReason).toBeNull();
  });

  it('gives a muted decline `other` only when it said something', async () => {
    // Requested before the mute: a muted seller takes no new requests.
    const { id: silent } = await request();
    const { id: spoke } = await request({ buyerId: STRANGER });
    await mute(SELLER);
    await deals.declineServiceDeal({ dealId: silent, userId: SELLER });
    expect(await lastEvent(silent)).toMatchObject({ comment: null, reasonCode: null });

    await deals.declineServiceDeal({ dealId: spoke, userId: SELLER, reason: 'nope' });
    expect(await lastEvent(spoke)).toMatchObject({ comment: null, reasonCode: 'other' });
  });

  it("scans and keeps an unmuted buyer's dispute text, on the event and the deal", async () => {
    const id = await completed();
    scan.mockClear();
    await deals.openServiceDealDispute({
      dealId: id,
      userId: BUYER,
      reason: 'zip is empty',
      reasonCode: 'files_missing_or_broken',
    });
    expect(await lastEvent(id)).toEqual({
      type: 'Disputed',
      comment: 'zip is empty',
      reasonCode: 'files_missing_or_broken',
    });
    expect((await reasons(id)).disputeReason).toBe('zip is empty');
    expect(scan).toHaveBeenCalledWith('zip is empty', expect.anything());
  });

  it("scans and keeps an unmuted party's answer to a cancellation", async () => {
    const id = await accepted();
    await deals.requestServiceDealCancellation({ dealId: id, userId: BUYER, reason: 'r' });
    scan.mockClear();
    await deals.respondServiceDealCancellation({
      dealId: id,
      userId: SELLER,
      agree: true,
      comment: 'fair enough',
    });
    expect(await lastEvent(id)).toEqual({
      type: 'CancellationAccepted',
      comment: 'fair enough',
      reasonCode: null,
    });
    expect(scan).toHaveBeenCalledWith('fair enough', expect.anything());
  });

  it("drops a muted party's answer to a cancellation, with no code", async () => {
    const id = await accepted();
    await deals.requestServiceDealCancellation({ dealId: id, userId: BUYER, reason: 'r' });
    await mute(SELLER);
    await deals.respondServiceDealCancellation({
      dealId: id,
      userId: SELLER,
      agree: false,
      comment: 'no way',
    });
    expect(await lastEvent(id)).toEqual({
      type: 'CancellationDeclined',
      comment: null,
      reasonCode: null,
    });
    // The system's own reason for the dispute is not the party's text, and stays.
    expect((await reasons(id)).disputeReason).toBe('cancellation_declined');
  });

  // The mute is read again inside the transition, so one landing after the text was scanned wins.
  it('drops text scanned before a mute that lands before the transition', async () => {
    const id = await accepted();
    scan.mockImplementationOnce(async () => {
      await mute(BUYER);
    });
    await deals.requestServiceDealCancellation({ dealId: id, userId: BUYER, reason: 'r' });
    expect(await lastEvent(id)).toMatchObject({ comment: null, reasonCode: 'other' });
    expect((await reasons(id)).cancellationReason).toBeNull();
  });

  // The other way round, the text was never scanned, so it must not be stored either.
  it('never stores the unscanned text of a party unmuted before the transition', async () => {
    const id = await accepted();
    await mute(BUYER);
    dbMock.dbWrite.$transaction.mockImplementationOnce((async (
      fn: (tx: unknown) => Promise<unknown>
    ) => {
      await mute(BUYER, false);
      return holder.db.transaction((tx) => fn(bridge(tx)));
    }) as never);
    scan.mockClear();
    await deals.requestServiceDealCancellation({ dealId: id, userId: BUYER, reason: 'unscanned' });
    expect(scan).not.toHaveBeenCalled();
    expect(await lastEvent(id)).toMatchObject({ comment: null, reasonCode: 'other' });
    expect((await reasons(id)).cancellationReason).toBeNull();
  });

  it('lists event codes in the dispute queue', async () => {
    const id = await completed();
    await deals.openServiceDealDispute({
      dealId: id,
      userId: BUYER,
      reasonCode: 'not_as_previewed',
    });
    const { items } = await deals.listDisputedServiceDeals({ viewerId: STRANGER });
    expect(items[0].events.at(-1)).toMatchObject({
      type: 'Disputed',
      comment: null,
      reasonCode: 'not_as_previewed',
    });
  });

  describe('the deal view', () => {
    const view = (servicesEnabled: boolean, userId = BUYER) => {
      const at = new Date();
      (
        dbMock.dbWrite as unknown as { serviceDeal: { findUnique: ReturnType<typeof vi.fn> } }
      ).serviceDeal.findUnique = vi.fn().mockResolvedValue({
        id: 9,
        offering: OFFERING_ROW,
        buyerId: BUYER,
        sellerId: SELLER,
        status: 'Delivered',
        revisionsUsed: 0,
        revisionsIncluded: 1,
        requestedAt: at,
        deliveredAt: at,
        heldAt: at,
        maxNsfwLevel: R,
        events: [
          {
            id: 1,
            type: 'Declined',
            actorId: SELLER,
            round: 0,
            comment: null,
            reasonCode: 'too_busy',
            createdAt: at,
          },
        ],
      });
      return deals.getServiceDealView({ dealId: 9, userId, servicesEnabled });
    };

    it("reports the viewer's mute from their User row", async () => {
      expect((await view(true)).viewerMuted).toBe(false);
      await mute(BUYER);
      expect((await view(true)).viewerMuted).toBe(true);
    });

    it("returns each event's code", async () => {
      expect((await view(true)).events[0].reasonCode).toBe('too_busy');
    });

    // The page gates itself on these, as it does any mature content.
    it("returns the deal's rating, and whether it is mature", async () => {
      expect(await view(true)).toMatchObject({ maxNsfwLevel: R, mature: true });
    });

    it('offers the flag-gated actions only while the flag is on', async () => {
      expect((await view(true)).actions).toContain('requestRevision');
      expect((await view(false)).actions).toEqual(['acceptDelivery', 'requestCancellation']);
    });

    // `guardedProcedure` refuses a muted user a revision request; the exits stay offered.
    it('offers a muted viewer only the actions the router lets them take', async () => {
      await mute(BUYER);
      expect((await view(true)).actions).toEqual(['acceptDelivery', 'requestCancellation']);
    });

    it('lists the same actions, by the flag and by the mute', async () => {
      const id = await accepted();
      await deliver(id);
      const listed = async (servicesEnabled = true) => {
        const row = (await q(`SELECT * FROM "ServiceDeal" WHERE id = $1`, [id]))[0];
        (
          dbMock.dbWrite as unknown as { serviceDeal: { findMany: ReturnType<typeof vi.fn> } }
        ).serviceDeal.findMany = vi.fn().mockResolvedValue([{ ...row, offering: OFFERING_ROW }]);
        const { items } = await deals.listMyServiceDeals({
          userId: BUYER,
          role: 'buyer',
          limit: 20,
          servicesEnabled,
        });
        return items[0].actions;
      };
      expect(await listed()).toContain('requestRevision');
      expect(await listed(false)).toEqual(['acceptDelivery', 'requestCancellation']);
      await mute(BUYER);
      expect(await listed()).toEqual(['acceptDelivery', 'requestCancellation']);
    });
  });
});

// Mature services (decision, briony 2026-10-15): SFW is always requestable; a mature service only on a
// domain that serves its level, by a buyer whose own browsing level includes it.
describe('mature services', () => {
  const rate = (level: number) => q(`UPDATE "ServiceOffering" SET "maxNsfwLevel" = $1`, [level]);
  const dealLevel = async (id: number) =>
    (
      await q<{ maxNsfwLevel: number }>(`SELECT "maxNsfwLevel" FROM "ServiceDeal" WHERE id = $1`, [
        id,
      ])
    )[0].maxNsfwLevel;
  const dealCount = async () =>
    (await q<{ n: number }>(`SELECT count(*)::int n FROM "ServiceDeal"`))[0].n;

  it('lets a PG-only buyer request a PG-13 service, on either domain', async () => {
    await rate(PG13);
    const { id } = await request({ consentLevels: PG, servableLevels: SFW_LEVELS });
    expect(await dealLevel(id)).toBe(PG13);
  });

  it('refuses a PG-only buyer an R service, and holds nothing', async () => {
    await rate(R);
    await expect(request({ consentLevels: PG })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await dealCount()).toBe(0);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('takes an R service from a buyer who opted into R, and snapshots its rating', async () => {
    await rate(R);
    const { id } = await request({ consentLevels: PG | R });
    expect(await dealLevel(id)).toBe(R);
    // The deal keeps its rating whatever the offering does later.
    await rate(PG13);
    expect(await dealLevel(id)).toBe(R);
  });

  it('answers a hidden mature service as not found, never as mature', async () => {
    await rate(R);
    shop.assertCreatorShopVisible.mockRejectedValueOnce(
      new TRPCError({ code: 'NOT_FOUND', message: 'Shop not found' })
    );
    await expect(request({ consentLevels: PG })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers a blocked buyer as blocked, never as mature', async () => {
    await rate(R);
    await q(`INSERT INTO "UserEngagement" VALUES ($1, $2, 'Block')`, [SELLER, BUYER]);
    await expect(request({ consentLevels: PG })).rejects.toThrow(/cannot request this service/);
  });

  it('does not find a mature service on the SFW domain, even for a buyer who opted in', async () => {
    await rate(R);
    await expect(
      request({ servableLevels: SFW_LEVELS, consentLevels: ALL_LEVELS })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await dealCount()).toBe(0);
  });

  // The checks before the INSERT are for the message; the INSERT repeats the rule itself.
  it('refuses at the insert a service made mature after the checks, and holds nothing', async () => {
    await rate(PG13);
    shop.assertCreatorShopVisible.mockImplementationOnce(async () => {
      await rate(R);
      return [];
    });
    await expect(request({ consentLevels: PG })).rejects.toEqual(conflict);
    expect(await dealCount()).toBe(0);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses at the insert a mature service on the SFW domain, past the checks', async () => {
    await rate(PG13);
    shop.assertCreatorShopVisible.mockImplementationOnce(async () => {
      await rate(R);
      return [];
    });
    await expect(
      request({ servableLevels: SFW_LEVELS, consentLevels: ALL_LEVELS })
    ).rejects.toEqual(conflict);
    expect(await dealCount()).toBe(0);
  });

  describe('listing my deals', () => {
    // The Prisma model calls are mocked in this suite; these run them against the real rows.
    const fakePrisma = () => {
      type Where = { buyerId?: number; maxNsfwLevel?: { in?: number[]; notIn?: number[] } };
      type Row = { buyerId: number; maxNsfwLevel: number };
      const matches = (row: Row, where: Where) =>
        (where.buyerId === undefined || row.buyerId === where.buyerId) &&
        (where.maxNsfwLevel?.in === undefined ||
          where.maxNsfwLevel.in.includes(row.maxNsfwLevel)) &&
        (where.maxNsfwLevel?.notIn === undefined ||
          !where.maxNsfwLevel.notIn.includes(row.maxNsfwLevel));
      const rows = () => q<Row>(`SELECT * FROM "ServiceDeal" ORDER BY id DESC`);
      const model = dbMock.dbWrite as unknown as {
        serviceDeal: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
      };
      model.serviceDeal.findMany = vi.fn(async ({ where }) =>
        (await rows())
          .filter((row) => matches(row, where))
          .map((row) => ({ ...row, offering: OFFERING_ROW }))
      );
      model.serviceDeal.count = vi.fn(
        async ({ where }) => (await rows()).filter((row) => matches(row, where)).length
      );
    };
    const list = (servableLevels: number) =>
      deals.listMyServiceDeals({
        userId: BUYER,
        role: 'buyer',
        limit: 20,
        servicesEnabled: true,
        servableLevels,
      });

    it('leaves mature deals out on the SFW domain and says how many', async () => {
      const { id: sfw } = await request();
      // One unanswered request per buyer per offering: answer the first.
      await deals.declineServiceDeal({ dealId: sfw, userId: SELLER });
      await rate(R);
      const { id: mature } = await request({ consentLevels: PG | R });
      // Another buyer's mature deal: never in this buyer's list, nor in their count.
      await request({ buyerId: STRANGER, consentLevels: PG | R });
      fakePrisma();

      const green = await list(SFW_LEVELS);
      expect(green.items.map((item) => item.id)).toEqual([sfw]);
      expect(green.hiddenOffDomain).toBe(1);

      const red = await list(ALL_LEVELS);
      expect(red.items.map((item) => item.id)).toEqual([mature, sfw]);
      expect(red.items[0].maxNsfwLevel).toBe(R);
      expect(red.hiddenOffDomain).toBe(0);
    });
  });
});

// Decision (briony, 2026-10-15): a moderator takedown sets the offering to Removed and does NOT
// cancel or refund its open deals. Buyers keep every exit and moderators have the dispute queue.
// What the takedown must still do is stop NEW requests, which the Active check in the request
// path already does. Do not add a cascade from takedown into deals without that decision changing.
describe('an offering taken down mid-deal', () => {
  const takeDown = () =>
    q(`UPDATE "ServiceOffering" SET status = 'Removed'::"ServiceOfferingStatus" WHERE id = 1`);

  it('refuses a new request', async () => {
    await takeDown();
    await expect(request()).rejects.toThrow(/Service not found/);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('lets an open deal run to completion under its copied terms', async () => {
    const { id } = await request();
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    await takeDown();
    await deliver(id);
    await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
    expect((await deal(id)).status).toBe('Completed');
  });

  // Decision (briony, 2026-10-15): after a MODERATOR takedown a pending request cannot be accepted,
  // so a seller removed for a fraudulent listing never starts work on held Buzz. The buyer's exits
  // stay open and refund as normal. A seller's own remove leaves accept as it was.
  describe('by a moderator', () => {
    const moderatorTakeDown = () =>
      q(`UPDATE "ServiceOffering" SET status = 'Removed'::"ServiceOfferingStatus",
           "removedReason" = 'misleading', "removedAt" = now(), "removedById" = 99 WHERE id = 1`);

    it('refuses to accept a request that was pending at the takedown', async () => {
      const { id } = await request();
      await moderatorTakeDown();
      // Says why, rather than "moved on", which would send the seller back to the same button.
      await expect(deals.acceptServiceDeal({ dealId: id, userId: SELLER })).rejects.toThrow(
        'A moderator removed this service, so this request can only be declined.'
      );
      expect((await deal(id)).status).toBe('Requested');
      expect(await events(id)).toEqual(['Requested', 'Held']);
    });

    it("still refunds the buyer's withdraw of that request", async () => {
      const { id } = await request();
      await moderatorTakeDown();
      await deals.withdrawServiceDeal({ dealId: id, userId: BUYER });
      expect(await deal(id)).toMatchObject({ status: 'Cancelled', closeReason: 'withdrawn' });
      expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
      const refund = (await legs(id)).find((l) => l.leg === 'Refund');
      expect(refund?.transactionId).toBeTruthy();
    });

    it('stops offering Accept, and tells neither party the reason', async () => {
      const { id } = await request();
      const row = (await q(`SELECT * FROM "ServiceDeal" WHERE id = $1`, [id]))[0];
      const takenDown = { ...OFFERING_ROW, removedReason: 'misleading' };
      const model = dbMock.dbWrite as unknown as {
        serviceDeal: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
      };
      model.serviceDeal.findUnique = vi
        .fn()
        .mockResolvedValue({ ...row, offering: takenDown, events: [] });
      model.serviceDeal.findMany = vi.fn().mockResolvedValue([{ ...row, offering: takenDown }]);

      const view = await deals.getServiceDealView({
        dealId: id,
        userId: SELLER,
        servicesEnabled: true,
      });
      expect(view.actions).toEqual(['decline']);
      expect(view.offeringTakenDown).toBe(true);
      expect(JSON.stringify(view)).not.toContain('misleading');

      const { items } = await deals.listMyServiceDeals({
        userId: SELLER,
        role: 'seller',
        limit: 20,
        servicesEnabled: true,
        servableLevels: ALL_LEVELS,
      });
      expect(items[0].actions).toEqual(['decline']);
      expect(items[0].offeringTakenDown).toBe(true);
      expect(JSON.stringify(items)).not.toContain('misleading');

      // Decision (briony, 2026-10-15): the seller's moderation status is not the buyer's to see.
      const buyerView = await deals.getServiceDealView({
        dealId: id,
        userId: BUYER,
        servicesEnabled: true,
      });
      expect(buyerView.offeringTakenDown).toBe(false);
      expect(buyerView.actions).toEqual(['withdraw']);
      const buyerList = await deals.listMyServiceDeals({
        userId: BUYER,
        role: 'buyer',
        limit: 20,
        servicesEnabled: true,
        servableLevels: ALL_LEVELS,
      });
      expect(buyerList.items[0].offeringTakenDown).toBe(false);
      const modView = await deals.getServiceDealView({
        dealId: id,
        userId: STRANGER,
        isModerator: true,
        servicesEnabled: true,
      });
      expect(modView.offeringTakenDown).toBe(true);
    });

    // Only the seller's own pending request learns why: anyone else, or a deal that has moved on,
    // gets the same "moved on" conflict as any other refused accept.
    it('says why only to the seller of a request still pending', async () => {
      const { id: pending } = await request();
      await moderatorTakeDown();
      await expect(deals.acceptServiceDeal({ dealId: pending, userId: STRANGER })).rejects.toEqual(
        conflict
      );
      await deals.withdrawServiceDeal({ dealId: pending, userId: BUYER });
      await expect(deals.acceptServiceDeal({ dealId: pending, userId: SELLER })).rejects.toEqual(
        conflict
      );
    });

    // State set by SQL: this suite has no Prisma model fakes, so it cannot call the takedown itself.
    // That a seller-removed offering can be taken down is pinned on `takedownServiceOffering`'s
    // scope in creator-service-takedown.service.test.ts; this pins what accept does in that state.
    it('refuses accept on an offering the seller removed and a moderator then took down', async () => {
      const { id } = await request();
      await takeDown();
      await moderatorTakeDown();
      await expect(deals.acceptServiceDeal({ dealId: id, userId: SELLER })).rejects.toThrow(
        'A moderator removed this service, so this request can only be declined.'
      );
      await deals.withdrawServiceDeal({ dealId: id, userId: BUYER });
      expect(await deal(id)).toMatchObject({ status: 'Cancelled', closeReason: 'withdrawn' });
      expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    });

    it("leaves accept alone after the seller's own remove", async () => {
      const { id } = await request();
      await takeDown();
      await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
      expect((await deal(id)).status).toBe('Accepted');
    });
  });
});

describe('site notifications', () => {
  /** What the deal notifications sent since the last `reset()`, as [recipient, type, link]. */
  const sent = () =>
    notifications.createNotification.mock.calls.map(([n]) => [
      n.userId,
      n.type,
      creatorServiceNotifications[n.type]?.prepareMessage(n)?.url,
    ]);
  const reset = () => notifications.createNotification.mockClear();
  const accepted = async () => {
    const { id } = await request();
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    reset();
    return id;
  };
  const delivered = async () => {
    const id = await accepted();
    await deliver(id);
    reset();
    return id;
  };

  it('tells the seller once about a request whose hold is confirmed', async () => {
    const { id } = await request();
    expect(sent()).toEqual([[SELLER, 'service-deal-requested', `/services/deals/${id}`]]);
  });

  it('tells nobody about a request whose hold was refused', async () => {
    buzz.createMultiAccountBuzzTransaction.mockRejectedValue(buzzError(400));
    await expect(request()).rejects.toThrow();
    expect(sent()).toEqual([]);
  });

  it('tells the seller about an unconfirmed request only once reconcile finds the charge', async () => {
    buzz.createMultiAccountBuzzTransaction.mockRejectedValueOnce(buzzError(504));
    const { id } = await request();
    expect(sent()).toEqual([]);

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
    await escrow.reconcileUnconfirmedHolds();
    expect(sent()).toEqual([[SELLER, 'service-deal-requested', `/services/deals/${id}`]]);
  });

  it('tells nobody when reconcile finds a hold that was already marked held', async () => {
    buzz.createMultiAccountBuzzTransaction.mockRejectedValueOnce(buzzError(504));
    const { id } = await request();
    await q(`UPDATE "ServiceDeal" SET "heldAt" = now() WHERE id = $1`, [id]);
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
    expect(sent()).toEqual([]);
  });

  it('tells nobody when reconcile finds nothing was charged', async () => {
    buzz.createMultiAccountBuzzTransaction.mockRejectedValueOnce(buzzError(504));
    const { id } = await request();
    await ageHoldLeg(id, 11);
    await escrow.reconcileUnconfirmedHolds();
    expect((await deal(id)).status).toBe('Cancelled');
    expect(sent()).toEqual([]);
  });

  it('tells the buyer once when the seller accepts, and nobody on a refused accept', async () => {
    const { id } = await request();
    reset();
    await expect(deals.acceptServiceDeal({ dealId: id, userId: STRANGER })).rejects.toEqual(
      conflict
    );
    expect(sent()).toEqual([]);
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    await expect(deals.acceptServiceDeal({ dealId: id, userId: SELLER })).rejects.toEqual(conflict);
    expect(sent()).toEqual([[BUYER, 'service-deal-accepted', `/services/deals/${id}`]]);
  });

  it('tells the buyer once when the seller declines, and nobody when the buyer tries to', async () => {
    const { id } = await request();
    reset();
    await expect(deals.declineServiceDeal({ dealId: id, userId: BUYER })).rejects.toEqual(conflict);
    expect(sent()).toEqual([]);
    await deals.declineServiceDeal({ dealId: id, userId: SELLER });
    expect(sent()).toEqual([[BUYER, 'service-deal-declined', `/services/deals/${id}`]]);
  });

  it('tells the buyer once when the request expires, and nobody before it does', async () => {
    const { id } = await request();
    reset();
    await age(id, 'requestedAt', 47);
    await deals.expireServiceDeals();
    expect(sent()).toEqual([]);
    await age(id, 'requestedAt', 49);
    await deals.expireServiceDeals();
    await deals.expireServiceDeals();
    expect(sent()).toEqual([[BUYER, 'service-deal-expired', `/services/deals/${id}`]]);
  });

  it('tells the buyer about each delivery once, and nobody when delivery is refused', async () => {
    const { id } = await request();
    reset();
    expect(await markDelivered(id)).toBe(false);
    expect(sent()).toEqual([]);

    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    reset();
    await deliver(id);
    await deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'tweak' });
    await deliver(id);
    const link = `/services/deals/${id}`;
    expect(sent()).toEqual([
      [BUYER, 'service-deal-delivered', link],
      [SELLER, 'service-deal-revision-requested', link],
      [BUYER, 'service-deal-delivered', link],
    ]);
    // Keyed per round: one key for both would let the second replace the first.
    const keys = notifications.createNotification.mock.calls.map(([n]) => n.key);
    expect(new Set(keys).size).toBe(3);
  });

  it('tells the seller once about a revision request, and nobody past the included revisions', async () => {
    const id = await delivered();
    await deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'tweak' });
    expect(sent()).toEqual([[SELLER, 'service-deal-revision-requested', `/services/deals/${id}`]]);

    await deliver(id);
    reset();
    await expect(
      deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'again' })
    ).rejects.toEqual(conflict);
    expect(sent()).toEqual([]);
  });

  it.each([
    ['buyer', BUYER, SELLER],
    ['seller', SELLER, BUYER],
  ])('tells the other party once when the %s asks to cancel', async (requestedBy, asker, other) => {
    const id = await accepted();
    await deals.requestServiceDealCancellation({ dealId: id, userId: asker, reason: 'r' });
    expect(sent()).toEqual([
      [other, 'service-deal-cancellation-requested', `/services/deals/${id}`],
    ]);
    expect(notifications.createNotification.mock.calls[0][0].details.requestedBy).toBe(requestedBy);
  });

  it('tells nobody about a cancellation request from a stranger or a repeat', async () => {
    const id = await accepted();
    await expect(
      deals.requestServiceDealCancellation({ dealId: id, userId: STRANGER, reason: 'r' })
    ).rejects.toEqual(conflict);
    await deals.requestServiceDealCancellation({ dealId: id, userId: BUYER, reason: 'r' });
    reset();
    await expect(
      deals.requestServiceDealCancellation({ dealId: id, userId: SELLER, reason: 'r' })
    ).rejects.toEqual(conflict);
    expect(sent()).toEqual([]);
  });

  it('tells the seller once when the buyer accepts delivery, and nobody while finals are pending', async () => {
    const id = await accepted();
    await finals(id, 'Pending');
    await markDelivered(id);
    reset();
    await expect(deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER })).rejects.toEqual(
      conflict
    );
    expect(sent()).toEqual([]);

    await q(`UPDATE "ServiceDealFile" SET "scanStatus" = 'Passed' WHERE "dealId" = $1`, [id]);
    await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
    expect(sent()).toEqual([[SELLER, 'service-deal-completed', `/services/deals/${id}`]]);
  });

  it('tells the seller once when a deal auto-completes', async () => {
    const id = await delivered();
    await age(id, 'deliveredAt', 73);
    await deals.autoCompleteServiceDeals();
    await deals.autoCompleteServiceDeals();
    expect(sent()).toEqual([[SELLER, 'service-deal-completed', `/services/deals/${id}`]]);
  });

  it('tells the seller once when they are paid, and nobody while the payment fails', async () => {
    const id = await delivered();
    await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
    await q(`UPDATE "ServiceDeal" SET "releaseAt" = now() - interval '1 minute' WHERE id = $1`, [
      id,
    ]);
    reset();
    buzz.createBuzzTransaction.mockRejectedValueOnce(buzzError(503));
    await escrow.sweepServiceDealReleases();
    expect(sent()).toEqual([]);

    await q(`UPDATE "ServiceDealTransaction" SET "lastAttemptAt" = NULL WHERE "dealId" = $1`, [id]);
    await escrow.sweepServiceDealReleases();
    await escrow.releaseDeal(id);
    expect((await deal(id)).settledAt).not.toBeNull();
    expect(sent()).toEqual([[SELLER, 'service-deal-paid-out', `/services/deals/${id}`]]);
  });

  it('stays silent on withdrawals, cancellation answers and dispute resolution', async () => {
    const agreed = await accepted();
    const disputed = await accepted();
    const withdrawn = (await request()).id;
    for (const id of [agreed, disputed])
      await deals.requestServiceDealCancellation({ dealId: id, userId: BUYER, reason: 'r' });
    reset();

    await deals.withdrawServiceDeal({ dealId: withdrawn, userId: BUYER });
    await deals.respondServiceDealCancellation({ dealId: agreed, userId: SELLER, agree: true });
    await deals.respondServiceDealCancellation({ dealId: disputed, userId: SELLER, agree: false });
    await deals.resolveServiceDealDispute({
      dealId: disputed,
      moderatorId: STRANGER,
      resolution: 'Refund',
      note: 'n',
    });
    expect((await deal(disputed)).status).toBe('Cancelled');
    expect(sent()).toEqual([]);
  });

  it('keeps a committed move when the notification cannot be sent', async () => {
    const { id } = await request();
    notifications.createNotification.mockRejectedValueOnce(new Error('down'));
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    expect((await deal(id)).status).toBe('Accepted');
  });
});

describe('dispute reviews', () => {
  const disputed = async (buyerId = BUYER) => {
    const { id } = await request({ buyerId });
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    await deliver(id);
    await deals.acceptServiceDealDelivery({ dealId: id, userId: buyerId });
    await deals.openServiceDealDispute({ dealId: id, userId: buyerId, reason: 'not as previewed' });
    return id;
  };
  const review = (dealId: number, proposal: 'Refund' | 'Release' | null, reviewerId = STRANGER) =>
    reviews.createServiceDisputeReview({
      dealId,
      reviewerId,
      class: 'B1',
      proposal,
      confidence: proposal ? 0.8 : null,
      rationale: 'why',
      evidence: { files: 1 },
      agentVersion: 'test-1',
      mode: 'shadow',
    });
  const rows = (dealId: number) =>
    q<{
      proposal: string | null;
      humanRuling: string | null;
      humanId: number | null;
      agreed: boolean | null;
    }>(
      `SELECT proposal::text, "humanRuling"::text, "humanId", agreed FROM "ServiceDisputeReview"
       WHERE "dealId" = $1 ORDER BY id`,
      [dealId]
    );
  const latestOnQueue = async (id: number, viewerId = STRANGER) =>
    (await deals.listDisputedServiceDeals({ viewerId })).items.find((item) => item.id === id)
      ?.latestReview;
  const resolve = (id: number, resolution: 'Refund' | 'Release') =>
    deals.resolveServiceDealDispute({ dealId: id, moderatorId: STRANGER, resolution });

  it('refuses a review of a deal that is not Disputed, and writes nothing', async () => {
    const { id } = await request();
    await expect(review(id, 'Refund')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await rows(id)).toEqual([]);
  });

  it.each([
    ['buyer', BUYER],
    ['seller', SELLER],
  ])('refuses a reviewer who is the %s, and evidence to them', async (_, party) => {
    const id = await disputed();
    await expect(review(id, 'Release', party)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      reviews.getServiceDisputeEvidence({ dealId: id, viewerId: party })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await rows(id)).toEqual([]);
  });

  it("shows each deal's latest review on the dispute queue, and null for a deal with none", async () => {
    const reviewed = await disputed();
    const unreviewed = await disputed();
    await review(reviewed, null);
    await review(reviewed, 'Refund');
    expect(await latestOnQueue(reviewed)).toMatchObject({
      proposal: 'Refund',
      class: 'B1',
      mode: 'shadow',
      rationale: 'why',
    });
    expect(await latestOnQueue(unreviewed)).toBeNull();
  });

  it.each([
    ['buyer', BUYER],
    ['seller', SELLER],
  ])('keeps the review off the queue for a moderator who is the %s', async (_, party) => {
    const id = await disputed();
    await review(id, 'Refund');
    expect(await latestOnQueue(id, party)).toBeNull();
    expect(await latestOnQueue(id)).toMatchObject({ proposal: 'Refund' });
  });

  it.each([
    ['agrees', 'Refund', true],
    ['disagrees', 'Release', false],
    ['escalated', null, null],
  ] as const)(
    'fills the latest review with the human ruling when it %s',
    async (_, proposal, agreed) => {
      const id = await disputed();
      await review(id, 'Release');
      await review(id, proposal);
      await resolve(id, 'Refund');
      expect(await rows(id)).toEqual([
        { proposal: 'Release', humanRuling: null, humanId: null, agreed: null },
        { proposal, humanRuling: 'Refund', humanId: STRANGER, agreed },
      ]);
    }
  );

  it('refuses a review once the deal is resolved', async () => {
    const id = await disputed();
    await resolve(id, 'Refund');
    await expect(review(id, 'Refund')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not carry a review over to a dispute reopened after its ruling', async () => {
    const id = await disputed();
    await review(id, 'Release');
    // Ages the dispute and its review so the reopening below is unambiguously after both.
    await q(
      `UPDATE "ServiceDeal" SET "disputeOpenedAt" = "disputeOpenedAt" - interval '2 hours' WHERE id = $1`,
      [id]
    );
    await q(`UPDATE "ServiceDisputeReview" SET "createdAt" = "createdAt" - interval '1 hour'`);
    await resolve(id, 'Release');
    // As a payout that holds the deal again does: the dispute reopens with a new opening time.
    await q(
      `UPDATE "ServiceDeal" SET status = 'Disputed', "disputeResolution" = NULL,
         "disputeResolvedAt" = NULL, "disputeResolvedById" = NULL, "disputeOpenedAt" = now()
       WHERE id = $1`,
      [id]
    );
    expect(await latestOnQueue(id)).toBeNull();

    await review(id, null);
    await resolve(id, 'Release');
    expect(await rows(id)).toEqual([
      { proposal: 'Release', humanRuling: 'Release', humanId: STRANGER, agreed: true },
      { proposal: null, humanRuling: 'Release', humanId: STRANGER, agreed: null },
    ]);
  });

  it("bundles the deal's evidence, and counts each party's other recent disputes", async () => {
    // The seller's other dispute, with a different buyer: it counts for the seller only.
    const sellersOther = await disputed(STRANGER);
    const id = await disputed();
    const evidence = await reviews.getServiceDisputeEvidence({ dealId: id, viewerId: STRANGER });
    expect(evidence.deal).toMatchObject({
      id,
      status: 'Disputed',
      buyerId: BUYER,
      sellerId: SELLER,
    });
    expect(evidence.offering.title).toBe('Cat portraits');
    expect(evidence.events.map((e) => e.type)).toContain('Disputed');
    expect(evidence.files).toEqual([
      expect.objectContaining({ kind: 'Final', scanStatus: 'Passed' }),
    ]);
    expect(evidence.priorDisputes).toEqual({ days: 90, buyer: 0, seller: 1 });
    // ClickHouse is not configured here: the access log reads as unknown, never as empty.
    expect(evidence.files[0].access).toBeUndefined();
    expect(evidence.accessRecordedSince).toBeNull();

    await q(
      `UPDATE "ServiceDeal" SET "disputeOpenedAt" = now() - interval '91 days' WHERE id = $1`,
      [sellersOther]
    );
    expect(
      (await reviews.getServiceDisputeEvidence({ dealId: id, viewerId: STRANGER })).priorDisputes
    ).toEqual({ days: 90, buyer: 0, seller: 0 });
  });

  it("puts each file's own accesses on it", async () => {
    const id = await disputed();
    await finals(id);
    const [a, b] = (
      await q<{ id: number }>(`SELECT id FROM "ServiceDealFile" WHERE "dealId" = $1 ORDER BY id`, [
        id,
      ])
    ).map((f) => f.id);
    const at = new Date('2026-10-01T00:00:00Z');
    const row = (fileId: number, role: 'Buyer' | 'Seller') => ({
      dealId: id,
      fileId,
      role,
      kind: 'Download' as const,
      count: 1,
      firstAt: at,
      lastAt: at,
    });
    accessLog.value = { rows: [row(a, 'Buyer'), row(b, 'Seller')], recordedSince: at };
    const evidence = await reviews.getServiceDisputeEvidence({ dealId: id, viewerId: STRANGER });
    expect(evidence.files.map((f) => [f.id, f.access?.map((x) => x.role)])).toEqual([
      [a, ['Buyer']],
      [b, ['Seller']],
    ]);
    expect(evidence.accessRecordedSince).toEqual(at);
  });
});
