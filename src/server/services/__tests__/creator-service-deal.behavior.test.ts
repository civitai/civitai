import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  BUYER_DISCLOSURE_VERSION,
  SERVICES_TERMS_VERSION,
} from '~/shared/constants/creator-service-terms.constants';
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
  return {
    $executeRaw: raw.executeRaw,
    $queryRaw: raw.queryRaw,
    // The one Prisma model write a transaction here makes: the CSAM review flag on images.
    image: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: { in: number[] } };
        data: { needsReview: string };
      }) => {
        const { affectedRows } = await db.query(
          `UPDATE "Image" SET "needsReview" = $1 WHERE id = ANY($2::int[])`,
          [data.needsReview, where.id.in]
        );
        return { count: affectedRows ?? 0 };
      },
    },
  };
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

// The job's own context is irrelevant here; only which sweeps it runs is.
const jobDates = vi.hoisted(() => new Map<string, Date>());
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn({ checkIfCanceled: () => undefined }),
  }),
  getJobDate: async (key: string, fallback = new Date(0)) =>
    [
      jobDates.get(key) ?? fallback,
      async (date = new Date()) => {
        jobDates.set(key, date);
      },
    ] as const,
}));

const deals = await import('~/server/services/creator-service-deal.service');
const { creatorServiceDealsJob } = await import('~/server/jobs/creator-service-deal-jobs');
const reviews = await import('~/server/services/creator-service-dispute-review.service');
const escrow = await import('~/server/services/creator-service-escrow.service');
const dealReviews = await import('~/server/services/creator-service-deal-review.service');
const publish = await import('~/server/services/creator-service-deal-review-publish');
const reviewReports = await import('~/server/services/service-deal-review-report.service');
const reconcile = await import('~/server/services/creator-service-deal-review-reconcile');
const { REDIS_KEYS } = await import('~/server/redis/client');
const { resetTextScanRolloutCache } = await import('~/server/services/text-scan/mode');
const { creatorServiceNotifications } = await import(
  '~/server/notifications/creator-service.notifications'
);
const { MAX_LEG_ATTEMPTS } = await import('~/server/services/placement-escrow.service');
const { TransactionType } = await import('~/shared/constants/buzz.constants');
const { SERVICE_PRICE_MIN } = await import('~/shared/constants/creator-service.constants');

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261025120000_creator_services_foundation/migration.sql'
);
const TEXT_SCAN_HOLD_MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261016150000_text_scan_hold/migration.sql'
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
  '20261224150000_service_deal_file_removed_at',
  '20270106120000_service_offering_content_scan',
  '20271119070000_service_deal_file_scanned_etag',
  '20271120030000_service_license_presets',
  '20271120100000_service_deal_reviewed_happy',
  '20271120100100_service_deal_reviews',
  '20271120230000_service_deal_review_report',
  '20271125130000_service_deal_buyer_disclosure',
  '20271128130000_service_request_form',
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
const OFFERING_ROW = {
  id: 1,
  title: 'Cat portraits',
  coverImageId: null,
  removedReason: null,
  ingestion: 'Scanned',
};

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
      reviewEnabledAt: Date | null;
      offeringId: number;
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
    disclosureVersion: BUYER_DISCLOSURE_VERSION,
    // The disclosure a buyer under this flag is shown.
    disclosureReviewEnabled: !!overrides.reviewEnabled,
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
    CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp, "deletedAt" timestamp, muted boolean NOT NULL DEFAULT false, "createdAt" timestamp(3) NOT NULL DEFAULT now() - interval '1 year');
    CREATE TYPE "UserEngagementType" AS ENUM ('Hide', 'Follow', 'Block');
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type "UserEngagementType");
    CREATE TABLE "Report" (id serial PRIMARY KEY, reason text, details jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE "ModActivity" ("userId" int, "entityType" text, "entityId" int, activity text, UNIQUE ("userId", "entityType", "entityId", activity));
    CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb NOT NULL);
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (id serial PRIMARY KEY, url text, poi boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
      "needsReview" text, "nsfwLevel" int NOT NULL DEFAULT 0,
      "tosViolation" boolean NOT NULL DEFAULT false);
  `);
  // The review text check reads the csam queue's rows.
  await holder.db.exec(`
    CREATE TABLE "EntityModeration" ("entityType" text NOT NULL, "entityId" int NOT NULL, blocked boolean,
      "triggeredLabels" text[] NOT NULL DEFAULT '{}', result jsonb, "nsfwLevel" int, "workflowId" text,
      status text NOT NULL DEFAULT 'Succeeded', "retryCount" int NOT NULL DEFAULT 0,
      "updatedAt" timestamp(3) NOT NULL DEFAULT now(), PRIMARY KEY ("entityType", "entityId"));
  `);
  await holder.db.exec(readFileSync(TEXT_SCAN_HOLD_MIGRATION, 'utf8'));
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
    TRUNCATE "TextScanHold", "ServiceDealReviewReport", "Report", "ModActivity", "EntityModeration", "ServiceDealReviewImage", "ServiceDealReview", "ServiceDisputeReview", "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal", "ServiceOfferingReport", "ServiceOffering", "UserEngagement", "Image" RESTART IDENTITY;
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER}), (${STRANGER});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "revisionsIncluded", "previewKind", status, ingestion, "updatedAt")
      VALUES (${SELLER}, 'Cat portraits', 'desc', ${PRICE}, 3, 1, 'Video', 'Active', 'Scanned', now());
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
    ["the seller terms' version", SERVICES_TERMS_VERSION],
  ])(
    'refuses a request sent with %s of the buyer disclosure, before any charge',
    async (_, disclosureVersion) => {
      await expect(request({ disclosureVersion })).rejects.toThrow(/Review the request terms/);
      expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
      expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['without reviews, shown the review disclosure', { disclosureReviewEnabled: true }],
    [
      'with reviews, shown the disclosure without them',
      { reviewEnabled: true, disclosureReviewEnabled: false },
    ],
  ])('refuses a request %s, before any charge', async (_, overrides) => {
    await expect(request(overrides)).rejects.toThrow(/Review the request terms/);
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses a request from an old page that names no disclosure form, before any charge', async () => {
    await expect(request({ disclosureReviewEnabled: undefined })).rejects.toThrow(
      'Review the request terms before sending. Nothing was charged.'
    );
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  // Legal's text as written (decision: civitai/civitai#10253): each deal keeps the version and the exact lines its buyer was shown.
  const held = `${PRICE.toLocaleString()} Buzz is held now. Refunded if the seller declines, doesn't accept within 48 hours, or you withdraw before they accept.`;
  const shared = [
    held,
    'Delivery within 3 days of acceptance. 1 revision included.',
    "Accept or request an included revision. You can't reject a delivery, but you can ask to cancel. If you do nothing, it completes 72 hours after the latest delivery.",
    "Either side can ask to cancel before completion. You're refunded if the other side agrees or doesn't answer within 48 hours. If they decline, a Civitai moderator decides.",
  ];
  const notParty =
    "Civitai isn't a party to this deal. Don't pay or share payment details outside Civitai.";
  it.each([
    [
      'without reviews',
      false,
      'You have 48 hours after completion to dispute. Then the seller is paid. Moderator decisions on disputes and cancellations are final on Civitai.',
    ],
    [
      'with reviews',
      true,
      'You have 48 hours after completion to dispute. Then the seller is paid. If you review the work as Happy, the seller is paid right away and you can no longer dispute. Moderator decisions on disputes and cancellations are final on Civitai.',
    ],
  ])('stores the disclosure the buyer agreed to, %s', async (_, reviewEnabled, disputeLine) => {
    buzz.createMultiAccountBuzzTransaction.mockResolvedValue(charged());
    const { id } = await request({ reviewEnabled, disclosureReviewEnabled: reviewEnabled });
    expect(
      await q(
        `SELECT "buyerDisclosureVersion", "buyerDisclosureLines" FROM "ServiceDeal" WHERE id = $1`,
        [id]
      )
    ).toEqual([
      {
        buyerDisclosureVersion: BUYER_DISCLOSURE_VERSION,
        buyerDisclosureLines: [...shared, disputeLine, notParty],
      },
    ]);
  });

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
  ])('refuses a request to a %s seller, before any charge', async (_name, set) => {
    await q(`UPDATE "User" SET ${set} WHERE id = $1`, [SELLER]);
    await expect(request()).rejects.toThrow(/Service not found/);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it("answers a muted seller's offering exactly as a banned one's, before any charge", async () => {
    const answer = (error: unknown) => {
      const { name, code, message } = error as { name: string; code: string; message: string };
      return { name, code, message };
    };
    await q(`UPDATE "User" SET muted = true WHERE id = $1`, [SELLER]);
    const muted = answer(await request().catch((e) => e));
    await q(`UPDATE "User" SET muted = false, "bannedAt" = now() WHERE id = $1`, [SELLER]);
    const banned = answer(await request().catch((e) => e));
    expect(muted.code).toBeDefined();
    expect(muted).toEqual(banned);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
  });

  it('takes the same request once the seller is no longer muted', async () => {
    await q(`UPDATE "User" SET muted = true WHERE id = $1`, [SELLER]);
    await expect(request()).rejects.toThrow();
    await q(`UPDATE "User" SET muted = false WHERE id = $1`, [SELLER]);
    await expect(request()).resolves.toMatchObject({ id: expect.any(Number) });
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

describe('license terms', () => {
  const COMMERCIAL = {
    licensePreset: 'CommercialCredit' as const,
    licenseCustomText: null,
    licenseAllowResale: true,
  };
  const license = async (set: string) => q(`UPDATE "ServiceOffering" SET ${set}`);

  it('freezes the license the buyer agreed to onto the deal', async () => {
    await license(`"licensePreset" = 'CommercialCredit', "licenseAllowResale" = true`);
    const { id } = await request({ expectedLicense: COMMERCIAL, licenseAgreed: true });
    expect(await deal(id)).toMatchObject({
      licensePreset: 'CommercialCredit',
      licenseCustomText: null,
      licenseAllowResale: true,
      licenseAgreedAt: expect.any(Date),
    });
    // The seller changing terms later leaves the deal's alone.
    await license(`"licensePreset" = 'Personal', "licenseAllowResale" = false`);
    expect(await deal(id)).toMatchObject({ licensePreset: 'CommercialCredit' });
  });

  it("copies a Custom license's text as written", async () => {
    await license(`"licensePreset" = 'Custom', "licenseCustomText" = 'Print runs under 500 only.'`);
    const { id } = await request({
      expectedLicense: {
        licensePreset: 'Custom',
        licenseCustomText: 'Print runs under 500 only.',
        licenseAllowResale: false,
      },
      licenseAgreed: true,
    });
    expect(await deal(id)).toMatchObject({
      licensePreset: 'Custom',
      licenseCustomText: 'Print runs under 500 only.',
    });
  });

  it('refuses a request after the Custom text changed', async () => {
    await license(`"licensePreset" = 'Custom', "licenseCustomText" = 'Print runs under 5000.'`);
    await expect(
      request({
        expectedLicense: {
          licensePreset: 'Custom',
          licenseCustomText: 'Print runs under 500 only.',
          licenseAllowResale: false,
        },
        licenseAgreed: true,
      })
    ).rejects.toEqual(conflict);
  });

  // Each case changes one field of the license the buyer was shown.
  it.each([
    ['a different preset', `"licensePreset" = 'CommercialNoCredit'`],
    ['resale turned off', `"licenseAllowResale" = false`],
    ['the license removed', `"licensePreset" = NULL`],
  ])('refuses a request after %s, before any charge', async (_, set) => {
    await license(`"licensePreset" = 'CommercialCredit', "licenseAllowResale" = true`);
    await license(set);
    await expect(request({ expectedLicense: COMMERCIAL, licenseAgreed: true })).rejects.toEqual(
      expect.objectContaining({ code: 'CONFLICT', message: expect.stringMatching(/terms/) })
    );
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  // The INSERT repeats the license as its own precondition, for terms that change after the check.
  it.each([
    ['preset', `"licensePreset" = 'CommercialNoCredit'`],
    ['resale toggle', `"licenseAllowResale" = false`],
    ['custom text', `"licensePreset" = 'Custom', "licenseCustomText" = 'Mine.'`],
  ])(
    'creates no deal when the license %s changes between the check and the insert',
    async (_, change) => {
      await license(`"licensePreset" = 'CommercialCredit', "licenseAllowResale" = true`);
      shop.assertCreatorShopVisible.mockImplementationOnce(async () => {
        await license(change);
        return [];
      });
      await expect(request({ expectedLicense: COMMERCIAL, licenseAgreed: true })).rejects.toEqual(
        conflict
      );
      expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
      expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    }
  );

  it('refuses a request from a client that was shown no license, once the offering has one', async () => {
    await license(`"licensePreset" = 'CommercialNoCredit'`);
    await expect(request()).rejects.toEqual(conflict);
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
  });

  it('refuses a request on a licensed offering without the checkbox', async () => {
    await license(`"licensePreset" = 'CommercialCredit', "licenseAllowResale" = true`);
    await expect(request({ expectedLicense: COMMERCIAL, licenseAgreed: false })).rejects.toThrow(
      /Agree to the seller's license terms/
    );
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('records no agreement on an offering with no license', async () => {
    const { id } = await request();
    expect(await deal(id)).toMatchObject({ licensePreset: null, licenseAgreedAt: null });
  });
});

describe('a request form', () => {
  /** Base 500 over 3 days; a style that adds 300 and 2 days, and a required brief. */
  const FORM = {
    questions: [
      {
        type: 'pickOne',
        id: 'style',
        label: 'Style',
        options: [
          { id: 'sketch', label: 'Sketch', price: 0, days: 0 },
          { id: 'color', label: 'Full color', price: 300, days: 2 },
        ],
      },
      { type: 'text', id: 'brief', label: 'Describe it', required: true },
    ],
  };
  const withForm = (version = 1) =>
    q(`UPDATE "ServiceOffering" SET "requestForm" = $1::jsonb, "requestFormVersion" = $2`, [
      JSON.stringify(FORM),
      version,
    ]);
  const COLOR = { style: 'color', brief: 'a tabby, sleeping' };

  it('charges the total its answers give, and keeps the answers and the breakdown', async () => {
    await withForm();
    buzz.createMultiAccountBuzzTransaction.mockResolvedValue(charged(800));
    const { id } = await request({
      expectedPrice: 800,
      expectedDeliveryDays: 5,
      formVersion: 1,
      formAnswers: COLOR,
    });
    expect(await deal(id)).toMatchObject({
      price: 800,
      deliveryDays: 5,
      formVersion: 1,
      formAnswers: [
        { label: 'Style', answer: 'Full color' },
        { label: 'Describe it', answer: 'a tabby, sleeping' },
      ],
      priceBreakdown: [
        { label: 'Base', price: 500, days: 3 },
        { label: 'Full color', price: 300, days: 2 },
      ],
    });
  });

  it.each([
    ['a total other than its answers give', { expectedPrice: 500, expectedDeliveryDays: 5 }],
    ['days other than its answers give', { expectedPrice: 800, expectedDeliveryDays: 3 }],
    ['an older form', { expectedPrice: 800, expectedDeliveryDays: 5, formVersion: 0 }],
    [
      'the terms of a page that saw no form',
      {
        expectedPrice: 500,
        expectedDeliveryDays: 3,
        formVersion: undefined,
        formAnswers: undefined,
      },
    ],
  ])('refuses a request with %s as changed terms', async (_n, overrides) => {
    await withForm();
    await expect(request({ formVersion: 1, formAnswers: COLOR, ...overrides })).rejects.toEqual(
      expect.objectContaining({ code: 'CONFLICT' })
    );
    expect(await q(`SELECT id FROM "ServiceDeal"`)).toEqual([]);
  });

  it('refuses answers left out of a required question, and charges nothing', async () => {
    await withForm();
    await expect(
      request({ expectedPrice: 500, formVersion: 1, formAnswers: { style: 'sketch' } })
    ).rejects.toEqual(expect.objectContaining({ code: 'BAD_REQUEST' }));
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses answers sent after the seller removed the form', async () => {
    await expect(request({ formVersion: 1, formAnswers: COLOR })).rejects.toEqual(conflict);
  });

  it('checks the text answers as it checks the request text', async () => {
    await withForm();
    buzz.createMultiAccountBuzzTransaction.mockResolvedValue(charged(800));
    await request({
      expectedPrice: 800,
      expectedDeliveryDays: 5,
      formVersion: 1,
      formAnswers: COLOR,
    });
    expect(vi.mocked(throwOnBlockedUserContent)).toHaveBeenCalledWith(
      ['a tabby, sleeping'],
      expect.objectContaining({ surface: 'creator-service-request' })
    );
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

  it('posts the accepted line once however many times accept is sent', async () => {
    const { id } = await request();
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    await expect(deals.acceptServiceDeal({ dealId: id, userId: SELLER })).rejects.toEqual(conflict);
    expect(chat.createMessage).toHaveBeenCalledTimes(1);
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

  describe('while the seller is unavailable', () => {
    const UNAVAILABLE = [
      ['banned', `"bannedAt" = now()`],
      ['deleted', `"deletedAt" = now()`],
      ['restricted', `muted = true`],
    ] as const;
    const makeUnavailable = (set: string) => q(`UPDATE "User" SET ${set} WHERE id = $1`, [SELLER]);
    const unavailable = () => makeUnavailable(UNAVAILABLE[2][1]);
    const viewActions = async (id: number, userId: number) => {
      const row = (await q(`SELECT * FROM "ServiceDeal" WHERE id = $1`, [id]))[0];
      (
        dbMock.dbWrite as unknown as { serviceDeal: { findUnique: ReturnType<typeof vi.fn> } }
      ).serviceDeal.findUnique = vi
        .fn()
        .mockResolvedValue({ ...row, offering: OFFERING_ROW, events: [] });
      return (await deals.getServiceDealView({ dealId: id, userId, servicesEnabled: true }))
        .actions;
    };

    it.each(UNAVAILABLE)(
      'lets the buyer of a %s seller leave at once with a full refund, long before the due date',
      async (_name, set) => {
        const id = await accepted();
        await makeUnavailable(set);
        expect(await viewActions(id, BUYER)).toEqual(['cancelAndRefund', 'requestCancellation']);
        await deals.cancelServiceDealSellerUnavailable({ dealId: id, userId: BUYER });
        expect(await deal(id)).toMatchObject({ status: 'Cancelled', closeReason: 'buyer_refund' });
        expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
      }
    );

    it('pays one refund when the cancel is sent twice', async () => {
      const id = await accepted();
      await unavailable();
      await deals.cancelServiceDealSellerUnavailable({ dealId: id, userId: BUYER });
      await expect(
        deals.cancelServiceDealSellerUnavailable({ dealId: id, userId: BUYER })
      ).rejects.toEqual(conflict);
      expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    });

    it('also during a revision', async () => {
      const id = await accepted();
      await deliver(id);
      await deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'tweak' });
      await unavailable();
      await deals.cancelServiceDealSellerUnavailable({ dealId: id, userId: BUYER });
      expect(await deal(id)).toMatchObject({ status: 'Cancelled', closeReason: 'buyer_refund' });
      expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    });

    it('refuses it otherwise: the seller is available, the seller asks, or it was delivered', async () => {
      const id = await accepted();
      await expect(
        deals.cancelServiceDealSellerUnavailable({ dealId: id, userId: BUYER })
      ).rejects.toEqual(conflict);
      await unavailable();
      await expect(
        deals.cancelServiceDealSellerUnavailable({ dealId: id, userId: SELLER })
      ).rejects.toEqual(conflict);
      await deliver(id);
      await expect(
        deals.cancelServiceDealSellerUnavailable({ dealId: id, userId: BUYER })
      ).rejects.toEqual(conflict);
      expect(buzz.refundMultiAccountTransaction).not.toHaveBeenCalled();
    });

    it('offers it to the buyer only, and only while it applies', async () => {
      const id = await accepted();
      expect(await viewActions(id, BUYER)).not.toContain('cancelAndRefund');
      await unavailable();
      expect(await viewActions(id, BUYER)).toEqual(['cancelAndRefund', 'requestCancellation']);
      expect(await viewActions(id, SELLER)).not.toContain('cancelAndRefund');
    });
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

describe('an overdue deal nothing was delivered for', () => {
  const working = async (buyerId = BUYER) => {
    const { id } = await request({ buyerId });
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    return id;
  };
  const dueHoursAgo = (id: number, hours: number) =>
    q(`UPDATE "ServiceDeal" SET "dueAt" = now() - make_interval(hours => ${hours}) WHERE id = $1`, [
      id,
    ]);
  const dueDaysAgo = (id: number, days: number) => dueHoursAgo(id, days * 24);
  const ageRevisionRequests = (id: number, days: number) =>
    q(
      `UPDATE "ServiceDealEvent" SET "createdAt" = now() - make_interval(days => ${days})
       WHERE "dealId" = $1 AND type = 'RevisionRequested'`,
      [id]
    );
  /** A revision round opened `days` ago, on a deal whose due date passed long before. */
  const inRevision = async (days: number, buyerId = BUYER) => {
    const id = await working(buyerId);
    await deliver(id);
    await deals.requestServiceDealRevision({ dealId: id, userId: buyerId, comment: 'tweak' });
    await dueDaysAgo(id, 30);
    await ageRevisionRequests(id, days);
    return id;
  };

  it('is cancelled 7 days past due and refunded once, with a line in the deal chat', async () => {
    const id = await working();
    await dueDaysAgo(id, 8);
    expect(await deals.cancelOverdueServiceDeals()).toMatchObject({ moved: 1 });
    expect(await deal(id)).toMatchObject({ status: 'Cancelled', closeReason: 'overdue' });
    expect((await deal(id)).settledAt).not.toBeNull();
    expect((await legs(id)).filter((l) => l.leg === 'Refund')).toEqual([
      expect.objectContaining({ amount: PRICE }),
    ]);
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(await events(id)).toEqual(['Requested', 'Held', 'Accepted', 'Cancelled', 'Refunded']);
    expect(chat.createMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userId: -1,
        chatId: 77,
        content: `This deal was canceled automatically because nothing was delivered within 7 days of the due date. The buyer's Buzz has been refunded. [Open the deal](/services/deals/${id})`,
      })
    );
  });

  it('refunds once however many times the sweep runs', async () => {
    const id = await working();
    await dueDaysAgo(id, 8);
    await deals.cancelOverdueServiceDeals();
    expect(await deals.cancelOverdueServiceDeals()).toMatchObject({ moved: 0 });
    expect(await deals.cancelOverdueServiceDeal(id)).toBe(false);
    await escrow.sweepServiceDealRefunds();
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect((await legs(id)).filter((l) => l.leg === 'Refund')).toHaveLength(1);
  });

  it('is left alone until 7 days past due', async () => {
    const early = await working();
    const late = await working(STRANGER);
    await dueHoursAgo(early, 7 * 24 - 1);
    await dueHoursAgo(late, 7 * 24 + 1);
    expect(await deals.cancelOverdueServiceDeals()).toMatchObject({ moved: 1 });
    expect((await deal(early)).status).toBe('Accepted');
    expect(await deals.cancelOverdueServiceDeal(early)).toBe(false);
    expect((await deal(late)).status).toBe('Cancelled');
  });

  it('leaves a late delivery alone: the buyer has something to review', async () => {
    const delivered = await working();
    await dueDaysAgo(delivered, 8);
    await deliver(delivered);
    const undelivered = await working(STRANGER);
    await dueDaysAgo(undelivered, 8);
    expect(await deals.cancelOverdueServiceDeals()).toMatchObject({ moved: 1 });
    expect((await deal(delivered)).status).toBe('Delivered');
    expect(await deals.cancelOverdueServiceDeal(delivered)).toBe(false);
    expect((await deal(undelivered)).status).toBe('Cancelled');
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
  });

  // The revision keeps the original due date, so it counts from the request instead.
  it('gives a revision round 7 days from its request, not from the old due date', async () => {
    const fresh = await inRevision(6);
    const stale = await inRevision(8, STRANGER);
    expect(await deals.cancelOverdueServiceDeals()).toMatchObject({ moved: 1 });
    expect((await deal(fresh)).status).toBe('InRevision');
    expect(await deals.cancelOverdueServiceDeal(fresh)).toBe(false);
    expect(await deal(stale)).toMatchObject({ status: 'Cancelled', closeReason: 'overdue' });
    expect(chat.createMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        chatId: 77,
        content: `This deal was canceled automatically because the requested revision wasn't delivered within 7 days. The buyer's Buzz has been refunded. [Open the deal](/services/deals/${stale})`,
      })
    );
  });

  it('stays cancelled and refunded when the chat line cannot be posted', async () => {
    const id = await working();
    await dueDaysAgo(id, 8);
    chat.createMessage.mockRejectedValueOnce(new Error('chat down'));
    expect(await deals.cancelOverdueServiceDeals()).toMatchObject({ moved: 1 });
    expect(await deal(id)).toMatchObject({ status: 'Cancelled', closeReason: 'overdue' });
    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
  });

  it('counts a second revision round from its own request', async () => {
    const id = await working();
    await deliver(id);
    await q(`UPDATE "ServiceDeal" SET "revisionsIncluded" = 2 WHERE id = $1`, [id]);
    await deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'one' });
    await ageRevisionRequests(id, 8);
    await deliver(id);
    await deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'two' });
    await dueDaysAgo(id, 30);
    expect(await deals.cancelOverdueServiceDeals()).toMatchObject({ moved: 0 });
    expect((await deal(id)).status).toBe('InRevision');
  });

  it('runs in the creator-service-deals job', async () => {
    const id = await working();
    await dueDaysAgo(id, 8);
    expect(await creatorServiceDealsJob.run({})).toMatchObject({ overdue: { moved: 1 } });
    expect((await deal(id)).status).toBe('Cancelled');
  });

  it('never touches a deal in dispute or waiting on a cancellation answer', async () => {
    const disputed = await working();
    await deals.requestServiceDealCancellation({ dealId: disputed, userId: BUYER, reason: 'r' });
    await deals.respondServiceDealCancellation({ dealId: disputed, userId: SELLER, agree: false });
    const asked = await working(STRANGER);
    await deals.requestServiceDealCancellation({ dealId: asked, userId: STRANGER, reason: 'r' });
    for (const id of [disputed, asked]) await dueDaysAgo(id, 30);
    const control = await inRevision(8);
    expect(await deals.cancelOverdueServiceDeals()).toMatchObject({ moved: 1 });
    expect((await deal(disputed)).status).toBe('Disputed');
    expect((await deal(asked)).status).toBe('CancellationRequested');
    expect(await deals.cancelOverdueServiceDeal(disputed)).toBe(false);
    expect(await deals.cancelOverdueServiceDeal(asked)).toBe(false);
    expect((await deal(control)).status).toBe('Cancelled');
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

// An offering is shown, and takes requests, once its content checks and its cover's are done.
describe('content checks', () => {
  const setIngestion = (ingestion: string) =>
    q(`UPDATE "ServiceOffering" SET ingestion = $1::"ServiceOfferingIngestionStatus"`, [ingestion]);
  const cover = async (
    ingestion: string,
    nsfwLevel: number,
    needsReview: string | null = null,
    tosViolation = false
  ) => {
    await q(
      `INSERT INTO "Image" (id, ingestion, "nsfwLevel", "needsReview", "tosViolation") VALUES (1, $1::"ImageIngestionStatus", $2, $3, $4)`,
      [ingestion, nsfwLevel, needsReview, tosViolation]
    );
    await q(`UPDATE "ServiceOffering" SET "coverImageId" = 1`);
  };
  const dealLevel = async (id: number) =>
    (
      await q<{ maxNsfwLevel: number }>(`SELECT "maxNsfwLevel" FROM "ServiceDeal" WHERE id = $1`, [
        id,
      ])
    )[0].maxNsfwLevel;

  it.each(['Pending', 'Error', 'Blocked'])(
    'takes no request while its check is %s',
    async (ingestion) => {
      await setIngestion(ingestion);
      await expect(request()).rejects.toThrow(/Service not found/);
      expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['unscanned', 'Pending', null, false],
    ['blocked', 'Blocked', null, false],
    ['held for review', 'Scanned', 'minor', false],
    ['taken down', 'Scanned', null, true],
  ] as const)(
    'takes no request with a cover that is %s',
    async (_, ingestion, needsReview, tos) => {
      await cover(ingestion, PG, needsReview, tos);
      await expect(request()).rejects.toThrow(/Service not found/);
    }
  );

  it("rates the deal with a scanned cover's level before the offering is recomputed", async () => {
    // Stored rating PG-13, cover scanned R: a PG-only buyer is refused, an R buyer gets an R deal.
    await cover('Scanned', R);
    await expect(request({ consentLevels: PG })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { id } = await request({ consentLevels: PG | R });
    expect(await dealLevel(id)).toBe(R);
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

describe('a held offering on its deals', () => {
  const hold = () =>
    q(
      `UPDATE "ServiceOffering" SET ingestion = 'Blocked'::"ServiceOfferingIngestionStatus" WHERE id = 1`
    );
  const titlesSentTo = (userId: number) =>
    notifications.createNotification.mock.calls
      .filter(([n]) => n.userId === userId)
      .map(([n]) => n.details.offeringTitle);
  const viewAs = async (id: number, ingestion: string, userId: number, isModerator = false) => {
    const row = (await q(`SELECT * FROM "ServiceDeal" WHERE id = $1`, [id]))[0];
    const offering = { ...OFFERING_ROW, ingestion, coverImageId: 7 };
    const model = dbMock.dbWrite as unknown as {
      serviceDeal: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    };
    model.serviceDeal.findUnique = vi.fn().mockResolvedValue({ ...row, offering, events: [] });
    model.serviceDeal.findMany = vi.fn().mockResolvedValue([{ ...row, offering }]);
    const view = await deals.getServiceDealView({
      dealId: id,
      userId,
      isModerator,
      servicesEnabled: true,
    });
    const { items } = await deals.listMyServiceDeals({
      userId,
      role: userId === SELLER ? 'seller' : 'buyer',
      limit: 20,
      servicesEnabled: true,
      servableLevels: ALL_LEVELS,
    });
    return { view: view.offering, listed: items[0].offering };
  };

  it('refuses to accept a request whose offering was held after it, and moves no Buzz', async () => {
    const { id } = await request();
    await hold();
    const buzzCalls = Object.values(buzz).map(
      (fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length
    );
    await expect(deals.acceptServiceDeal({ dealId: id, userId: SELLER })).rejects.toThrow(
      'This service is being reviewed, so this request cannot be accepted until that is done.'
    );
    expect((await deal(id)).status).toBe('Requested');
    expect(
      Object.values(buzz).map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length)
    ).toEqual(buzzCalls);
    expect(chat.createMessage).not.toHaveBeenCalled();
  });

  it("keeps a held offering's title and cover from the buyer's deal view, list and notices", async () => {
    const { id } = await request();
    await hold();
    notifications.createNotification.mockClear();
    await deals.declineServiceDeal({ dealId: id, userId: SELLER });

    expect(titlesSentTo(BUYER)).toEqual(['Service under review']);
    const buyer = await viewAs(id, 'Blocked', BUYER);
    expect(buyer.view).toEqual({ id: 1, title: 'Service under review', coverImageId: null });
    expect(buyer.listed).toEqual({ id: 1, title: 'Service under review', coverImageId: null });
  });

  it('shows the seller and moderators the live title of a held offering', async () => {
    const { id } = await request();
    await hold();
    expect((await viewAs(id, 'Blocked', SELLER)).view.title).toBe('Cat portraits');
    expect((await viewAs(id, 'Blocked', SELLER)).listed.title).toBe('Cat portraits');
    expect((await viewAs(id, 'Blocked', STRANGER, true)).view.title).toBe('Cat portraits');
  });

  it("shows the buyer a checked offering's title and cover", async () => {
    const { id } = await request();
    notifications.createNotification.mockClear();
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });

    expect(titlesSentTo(BUYER)).toEqual(['Cat portraits']);
    expect(JSON.stringify(chat.createMessage.mock.calls)).toContain('Cat portraits');
    const buyer = await viewAs(id, 'Scanned', BUYER);
    expect(buyer.view).toEqual({ id: 1, title: 'Cat portraits', coverImageId: 7 });
    expect(buyer.listed).toEqual({ id: 1, title: 'Cat portraits', coverImageId: 7 });
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
  const details = () =>
    notifications.createNotification.mock.calls.map(([n]) => [n.userId, n.details]);
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

  it('tells only the buyer when reconcile finds nothing was charged: the seller never saw the request', async () => {
    buzz.createMultiAccountBuzzTransaction.mockRejectedValueOnce(buzzError(504));
    const { id } = await request();
    await ageHoldLeg(id, 11);
    await escrow.reconcileUnconfirmedHolds();
    await escrow.reconcileUnconfirmedHolds();
    expect((await deal(id)).status).toBe('Cancelled');
    expect(sent()).toEqual([[BUYER, 'service-deal-cancelled', `/services/deals/${id}`]]);
    expect(details()[0][1]).toMatchObject({ closeReason: 'payment_failed' });
    expect(details()[0][1].buzzReturned).toBeUndefined();
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

  it('tells the seller when the buyer withdraws, and not the buyer who did it', async () => {
    const { id } = await request();
    reset();
    await deals.withdrawServiceDeal({ dealId: id, userId: BUYER });
    expect(sent()).toEqual([[SELLER, 'service-deal-cancelled', `/services/deals/${id}`]]);
    expect(details()[0][1]).toMatchObject({ requestedBy: 'buyer' });
  });

  it.each([
    [
      'overdue',
      async (id: number) => {
        await q(`UPDATE "ServiceDeal" SET "dueAt" = now() - interval '8 days' WHERE id = $1`, [id]);
        await deals.cancelOverdueServiceDeals();
      },
    ],
    [
      'cancellation_unanswered',
      async (id: number) => {
        await deals.requestServiceDealCancellation({ dealId: id, userId: BUYER, reason: 'r' });
        reset();
        await age(id, 'cancellationRequestedAt', 49);
        await deals.autoCancelServiceDeals();
      },
    ],
  ])(
    'tells both parties once, in one notice each, when a deal cancels as %s',
    async (code, cancel) => {
      const id = await accepted();
      await cancel(id);
      await deals.cancelOverdueServiceDeals();
      await deals.autoCancelServiceDeals();
      expect((await deal(id)).status).toBe('Cancelled');
      expect(sent()).toEqual([
        [BUYER, 'service-deal-cancelled', `/services/deals/${id}`],
        [SELLER, 'service-deal-cancelled', `/services/deals/${id}`],
      ]);
      const [buyer, seller] = notifications.createNotification.mock.calls.map(([n]) => n);
      expect(buyer.details).toMatchObject({ closeReason: code, buzzReturned: true });
      expect(seller.details).toMatchObject({ closeReason: code });
      expect(seller.details.buzzReturned).toBeUndefined();
      expect(creatorServiceNotifications[buyer.type].prepareMessage(buyer)?.message).toContain(
        'Your Buzz is being returned.'
      );
    }
  );

  it('tells the party who asked to cancel how the other answered', async () => {
    const agreed = await accepted();
    const declined = await accepted();
    for (const id of [agreed, declined])
      await deals.requestServiceDealCancellation({ dealId: id, userId: SELLER, reason: 'r' });
    reset();

    await deals.respondServiceDealCancellation({ dealId: agreed, userId: BUYER, agree: true });
    await deals.respondServiceDealCancellation({ dealId: declined, userId: BUYER, agree: false });
    expect(sent()).toEqual([
      [SELLER, 'service-deal-cancellation-accepted', `/services/deals/${agreed}`],
      [SELLER, 'service-deal-cancellation-declined', `/services/deals/${declined}`],
    ]);
    expect(details()[0][1]).toMatchObject({ requestedBy: 'buyer' });
  });

  it('tells the seller when the buyer disputes, and both parties how moderators resolved it', async () => {
    const refunded = await delivered();
    const released = await delivered();
    for (const id of [refunded, released]) {
      await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
      reset();
      await deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'broken' });
      expect(sent()).toEqual([[SELLER, 'service-deal-disputed', `/services/deals/${id}`]]);
    }
    reset();

    await deals.resolveServiceDealDispute({
      dealId: refunded,
      moderatorId: STRANGER,
      resolution: 'Refund',
      note: 'n',
    });
    await deals.resolveServiceDealDispute({
      dealId: released,
      moderatorId: STRANGER,
      resolution: 'Release',
      note: 'n',
    });
    expect(sent()).toEqual([
      [BUYER, 'service-deal-dispute-resolved', `/services/deals/${refunded}`],
      [SELLER, 'service-deal-dispute-resolved', `/services/deals/${refunded}`],
      [SELLER, 'service-deal-paid-out', `/services/deals/${released}`],
      [BUYER, 'service-deal-dispute-resolved', `/services/deals/${released}`],
      [SELLER, 'service-deal-dispute-resolved', `/services/deals/${released}`],
    ]);
    const resolved = notifications.createNotification.mock.calls
      .map(([n]) => n)
      .filter((n) => n.type === 'service-deal-dispute-resolved');
    expect(resolved.map((n) => n.details.resolution)).toEqual([
      'Refund',
      'Refund',
      'Release',
      'Release',
    ]);
    // Both parties of one deal are told under their own keys, so neither replaces the other.
    expect(new Set(resolved.map((n) => n.key)).size).toBe(4);
  });

  it('words each new notice for its reader', () => {
    const say = (type: string, details: Record<string, unknown>) =>
      creatorServiceNotifications[type].prepareMessage({
        details: { dealId: 1, offeringTitle: 'Logo', ...details },
      } as never)?.message;
    expect(say('service-deal-dispute-resolved', { resolution: 'Refund' })).toContain(
      'The Buzz goes back to the buyer.'
    );
    expect(say('service-deal-dispute-resolved', { resolution: 'Release' })).toContain(
      'The Buzz goes to the seller.'
    );
    expect(say('service-deal-cancellation-declined', { requestedBy: 'seller' })).toBe(
      'The seller declined to cancel the deal for "Logo". Moderators will review it.'
    );
    expect(say('service-deal-cancelled', { requestedBy: 'buyer' })).toBe(
      'The buyer canceled the deal for "Logo".'
    );
    expect(say('service-deal-cancelled', { closeReason: 'overdue', buzzReturned: true })).toBe(
      '"Logo": Canceled automatically: nothing delivered in time. Your Buzz is being returned.'
    );
  });

  describe('reminders', () => {
    const HOUR = 3_600_000;
    const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR);
    const remind = (sinceHours: number, upToHours = 0) =>
      deals.remindServiceDeals({ since: at(sinceHours), upTo: at(upToHours) });

    it('tells the buyer once, 48 hours after delivery, that it completes on its own', async () => {
      const id = await delivered();
      await age(id, 'deliveredAt', 47);
      await remind(-1);
      expect(sent()).toEqual([]);

      await age(id, 'deliveredAt', 49);
      await remind(-2);
      await remind(0, 0.1);
      expect(sent()).toEqual([[BUYER, 'service-deal-auto-complete-soon', `/services/deals/${id}`]]);
    });

    it('tells the seller once a day before the due date, and once when it passes', async () => {
      const id = await accepted();
      await q(`UPDATE "ServiceDeal" SET "dueAt" = now() + interval '25 hours' WHERE id = $1`, [id]);
      await remind(-1);
      expect(sent()).toEqual([]);

      await q(`UPDATE "ServiceDeal" SET "dueAt" = now() + interval '23 hours' WHERE id = $1`, [id]);
      await remind(-2);
      await remind(0, 0.1);
      expect(sent()).toEqual([[SELLER, 'service-deal-due-soon', `/services/deals/${id}`]]);
      reset();

      await q(`UPDATE "ServiceDeal" SET "dueAt" = now() - interval '30 minutes' WHERE id = $1`, [
        id,
      ]);
      await remind(-1);
      await remind(0, 0.1);
      expect(sent()).toEqual([[SELLER, 'service-deal-overdue', `/services/deals/${id}`]]);
    });

    it('skips a due-soon reminder a late run reaches after the due date', async () => {
      const id = await accepted();
      await q(`UPDATE "ServiceDeal" SET "dueAt" = now() - interval '1 hour' WHERE id = $1`, [id]);
      await remind(-30);
      expect(sent()).toEqual([[SELLER, 'service-deal-overdue', `/services/deals/${id}`]]);
    });

    it('reminds once from the deals job, however often it runs', async () => {
      jobDates.clear();
      const id = await accepted();
      await q(`UPDATE "ServiceDeal" SET "dueAt" = now() - interval '30 minutes' WHERE id = $1`, [
        id,
      ]);
      await creatorServiceDealsJob.run({});
      await creatorServiceDealsJob.run({});
      expect(sent()).toEqual([[SELLER, 'service-deal-overdue', `/services/deals/${id}`]]);
    });

    it('does not call a seller late for a revision asked for after the due date', async () => {
      const id = await delivered();
      await q(`UPDATE "ServiceDeal" SET "dueAt" = now() - interval '2 days' WHERE id = $1`, [id]);
      await deals.requestServiceDealRevision({ dealId: id, userId: BUYER, comment: 'tweak' });
      reset();
      await remind(-1);
      expect(sent()).toEqual([]);
    });

    it('keeps its window and still pays out when the reminders fail', async () => {
      jobDates.clear();
      const paid = await delivered();
      await deals.acceptServiceDealDelivery({ dealId: paid, userId: BUYER });
      await q(`UPDATE "ServiceDeal" SET "releaseAt" = now() - interval '1 minute' WHERE id = $1`, [
        paid,
      ]);
      jobDates.set('creator-service-deal-reminders', new Date(NaN));
      expect(await creatorServiceDealsJob.run({})).toMatchObject({ reminded: 0 });
      expect((await deal(paid)).settledAt).not.toBeNull();
      expect(Number.isNaN(jobDates.get('creator-service-deal-reminders')?.getTime())).toBe(true);
    });

    it('reminds nobody about a deal that has moved on', async () => {
      const id = await delivered();
      await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
      reset();
      await age(id, 'deliveredAt', 49);
      await remind(-2);
      expect(sent()).toEqual([]);
    });

    describe('to review', () => {
      const completed = async ({ enrolled = true } = {}) => {
        const { id } = await request({ reviewEnabled: enrolled });
        await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
        await deliver(id);
        await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
        reset();
        return id;
      };
      const releaseIn = (id: number, hours: number) =>
        q(
          `UPDATE "ServiceDeal" SET "releaseAt" = now() + make_interval(mins => ${hours * 60})
           WHERE id = $1`,
          [id]
        );
      const reviewDue = (id: number) => [BUYER, 'service-deal-review-due', `/services/deals/${id}`];

      it('asks the buyer 2 hours after they accept, and 12 hours before payout', async () => {
        const id = await completed();
        await age(id, 'completedAt', 1);
        await remind(-1);
        expect(sent()).toEqual([]);

        await age(id, 'completedAt', 3);
        await remind(-2);
        expect(sent()).toEqual([reviewDue(id)]);
        reset();

        // The next run's window starts after the first reminder, so only the second falls in it.
        await releaseIn(id, 11.75);
        await remind(-0.5);
        await remind(0, 0.1);
        expect(sent()).toEqual([reviewDue(id)]);
      });

      it('does not ask a buyer who already reviewed, or a deal not enrolled', async () => {
        const reviewed = await completed();
        await dealReviews.reviewServiceDeal({
          dealId: reviewed,
          userId: BUYER,
          verdict: 'NotQuite',
          reviewFlag: true,
        });
        const unenrolled = await completed({ enrolled: false });
        reset();
        for (const id of [reviewed, unenrolled]) {
          await age(id, 'completedAt', 3);
          await releaseIn(id, 11);
        }
        await remind(-2);
        expect(sent()).toEqual([]);
      });

      it('asks only once, before payout, about a deal that completed on its own', async () => {
        const { id } = await request({ reviewEnabled: true });
        await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
        await deliver(id);
        await age(id, 'deliveredAt', 73);
        expect(await deals.autoCompleteServiceDeal(id)).toBe(true);
        reset();

        await age(id, 'completedAt', 3);
        await remind(-2);
        expect(sent()).toEqual([]);

        await releaseIn(id, 11);
        await remind(-2);
        expect(sent()).toEqual([reviewDue(id)]);
      });
    });
  });

  it('keeps a committed move when the notification cannot be sent', async () => {
    const { id } = await request();
    notifications.createNotification.mockRejectedValueOnce(new Error('down'));
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    expect((await deal(id)).status).toBe('Accepted');
  });
});

describe('buyer reviews', () => {
  const review = (id: number, verdict: 'Happy' | 'NotQuite', extra: Record<string, unknown> = {}) =>
    dealReviews.reviewServiceDeal({
      dealId: id,
      userId: BUYER,
      verdict,
      reviewFlag: true,
      ...extra,
    });
  const completed = async ({ enrolled = true } = {}) => {
    const { id } = await request({ reviewEnabled: enrolled });
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    await deliver(id);
    await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
    return id;
  };
  const reviewRows = (id: number) =>
    q<{
      verdict: string;
      buyerId: number;
      sellerId: number;
      offeringId: number;
      scanStatus: string;
    }>(
      `SELECT "verdict"::text, "buyerId", "sellerId", "offeringId", "scanStatus"::text
       FROM "ServiceDealReview" WHERE "dealId" = $1`,
      [id]
    );
  const happyEvents = async (id: number) =>
    (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM "ServiceDealEvent" WHERE "dealId" = $1 AND type = 'ReviewedHappy'`,
        [id]
      )
    )[0].n;

  it('enrols a deal requested with the review flag, and only that one', async () => {
    const on = await completed();
    const off = await completed({ enrolled: false });
    expect((await deal(on)).reviewEnabledAt).not.toBeNull();
    expect((await deal(off)).reviewEnabledAt).toBeNull();
  });

  it('a happy review moves the release to now, writes one event and one review, and pays the seller', async () => {
    const id = await completed();
    expect((await deal(id)).releaseAt!.getTime()).toBeGreaterThan(Date.now());
    await review(id, 'Happy', { comment: 'Lovely work' });

    expect((await deal(id)).releaseAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await happyEvents(id)).toBe(1);
    expect(await reviewRows(id)).toEqual([
      {
        verdict: 'Happy',
        buyerId: BUYER,
        sellerId: SELLER,
        offeringId: (await deal(id)).offeringId,
        scanStatus: 'Pending',
      },
    ]);
    await escrow.sweepServiceDealReleases();
    expect((await deal(id)).settledAt).not.toBeNull();
    // The dispute window closed with the early release.
    await expect(
      deals.openServiceDealDispute({ dealId: id, userId: BUYER, reason: 'broken' })
    ).rejects.toEqual(conflict);
  });

  it('a second review, or one on a disputed, settled or unenrolled deal, writes nothing', async () => {
    const twice = await completed();
    await review(twice, 'Happy');
    await expect(review(twice, 'Happy')).rejects.toEqual(conflict);
    await expect(review(twice, 'NotQuite')).rejects.toEqual(conflict);
    expect(await happyEvents(twice)).toBe(1);

    const disputed = await completed();
    await deals.openServiceDealDispute({ dealId: disputed, userId: BUYER, reason: 'broken' });
    await expect(review(disputed, 'Happy')).rejects.toEqual(conflict);

    const settled = await completed();
    await q(`UPDATE "ServiceDeal" SET "settledAt" = now() WHERE id = $1`, [settled]);
    await expect(review(settled, 'Happy')).rejects.toEqual(conflict);
    await expect(review(settled, 'NotQuite')).rejects.toEqual(conflict);

    // A deal that was ever disputed is not released early, whatever its release time says.
    const onceDisputed = await completed();
    await q(`UPDATE "ServiceDeal" SET "disputeOpenedAt" = now() WHERE id = $1`, [onceDisputed]);
    await expect(review(onceDisputed, 'Happy')).rejects.toEqual(conflict);

    const unenrolled = await completed({ enrolled: false });
    await expect(review(unenrolled, 'Happy')).rejects.toEqual(conflict);

    for (const id of [disputed, settled, onceDisputed, unenrolled]) {
      expect(await reviewRows(id)).toEqual([]);
      expect(await happyEvents(id)).toBe(0);
    }
  });

  it('only the buyer may review, and only with the live flag', async () => {
    const id = await completed();
    await expect(
      dealReviews.reviewServiceDeal({
        dealId: id,
        userId: SELLER,
        verdict: 'Happy',
        reviewFlag: true,
      })
    ).rejects.toEqual(conflict);
    await expect(review(id, 'Happy', { reviewFlag: false })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await reviewRows(id)).toEqual([]);
  });

  it("copies the review's buyer, seller and offering from its deal, for either verdict", async () => {
    const happy = await completed();
    const notQuite = await completed();
    await review(happy, 'Happy');
    await review(notQuite, 'NotQuite');
    for (const id of [happy, notQuite]) {
      const d = (
        await q<{ buyerId: number; sellerId: number; offeringId: number }>(
          `SELECT "buyerId", "sellerId", "offeringId" FROM "ServiceDeal" WHERE id = $1`,
          [id]
        )
      )[0];
      expect(await reviewRows(id)).toMatchObject([d]);
    }
  });

  it('not quite records the review and leaves the release time alone', async () => {
    const id = await completed();
    const before = (await deal(id)).releaseAt;
    await review(id, 'NotQuite');
    expect((await deal(id)).releaseAt).toEqual(before);
    expect(await happyEvents(id)).toBe(0);
    expect(await reviewRows(id)).toMatchObject([{ verdict: 'NotQuite', scanStatus: 'Scanned' }]);
  });
});

describe('review publishing and counters', () => {
  const completedBy = async (buyerId = BUYER) => {
    const { id } = await request({ buyerId, reviewEnabled: true });
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    await deliver(id);
    await deals.acceptServiceDealDelivery({ dealId: id, userId: buyerId });
    return id;
  };
  const review = (
    dealId: number,
    verdict: 'Happy' | 'NotQuite',
    buyerId = BUYER,
    comment?: string
  ) =>
    dealReviews.reviewServiceDeal({ dealId, userId: buyerId, verdict, comment, reviewFlag: true });
  const published = async (dealId: number) =>
    (
      await q<{ publishedAt: Date | null }>(
        `SELECT "publishedAt" FROM "ServiceDealReview" WHERE "dealId" = $1`,
        [dealId]
      )
    )[0]?.publishedAt ?? null;
  const counters = async () =>
    (
      await q<{ happyCount: number; reviewCount: number; happySortKey: number }>(
        `SELECT "happyCount", "reviewCount", "happySortKey" FROM "ServiceOffering" WHERE id = 1`
      )
    )[0];
  const buyers = [10, 11, 12];
  beforeEach(async () => {
    await q(`INSERT INTO "User" (id) VALUES (10), (11), (12)`);
  });

  it('shows a happy review with no comment at once, and counts it', async () => {
    const id = await completedBy();
    await review(id, 'Happy');
    expect(await published(id)).not.toBeNull();
    expect(await counters()).toEqual({ happyCount: 1, reviewCount: 1, happySortKey: -1 });
  });

  it("waits on a comment's check before showing the review", async () => {
    const id = await completedBy();
    await review(id, 'Happy', BUYER, 'Lovely');
    expect(await published(id)).toBeNull();
    expect((await counters()).reviewCount).toBe(0);

    const [{ id: reviewId }] = await q<{ id: number }>(
      `UPDATE "ServiceDealReview" SET "scanStatus" = 'Scanned' WHERE "dealId" = $1 RETURNING id`,
      [id]
    );
    await publish.syncReviewPublication(reviewId);
    expect(await published(id)).not.toBeNull();
    expect((await counters()).happyCount).toBe(1);
  });

  it('shows a not-quite review only once the deal has settled', async () => {
    const id = await completedBy();
    await review(id, 'NotQuite');
    expect(await published(id)).toBeNull();
    await q(`UPDATE "ServiceDeal" SET "releaseAt" = now() - interval '1 minute' WHERE id = $1`, [
      id,
    ]);
    await escrow.sweepServiceDealReleases();
    expect((await deal(id)).settledAt).not.toBeNull();
    expect(await published(id)).not.toBeNull();
    expect(await counters()).toEqual({ happyCount: 0, reviewCount: 1, happySortKey: -1 });
  });

  it('scores the happy share once three buyers count, each buyer once', async () => {
    for (const [i, buyerId] of buyers.entries())
      await review(await completedBy(buyerId), i < 2 ? 'Happy' : 'NotQuite', buyerId);
    // Not quite is counted only once settled.
    await q(
      `UPDATE "ServiceDeal" SET "releaseAt" = now() - interval '1 minute' WHERE "buyerId" = 12`
    );
    await escrow.sweepServiceDealReleases();
    expect(await counters()).toEqual({ happyCount: 2, reviewCount: 3, happySortKey: 2 / 3 });

    // A second deal with the same buyer replaces their vote rather than adding one.
    await review(await completedBy(12), 'Happy', 12);
    expect(await counters()).toEqual({ happyCount: 3, reviewCount: 3, happySortKey: 1 });
  });

  it('counts a deal at the minimum price and not one under it', async () => {
    const atMin = await completedBy(10);
    await q(`UPDATE "ServiceDeal" SET price = $2 WHERE id = $1`, [atMin, SERVICE_PRICE_MIN]);
    await review(atMin, 'Happy', 10);
    expect((await counters()).reviewCount).toBe(1);
    const cheap = await completedBy(11);
    await q(`UPDATE "ServiceDeal" SET price = $2 WHERE id = $1`, [cheap, SERVICE_PRICE_MIN - 1]);
    await review(cheap, 'Happy', 11);
    // Shown, not counted.
    expect(await published(cheap)).not.toBeNull();
    expect((await counters()).reviewCount).toBe(1);
  });

  it("judges the buyer's account age at request, not now", async () => {
    const young = await completedBy(10);
    const old = await completedBy(11);
    // Requested a month ago: one account was 5 days old then, the other 8. Both are weeks old now.
    await q(
      `UPDATE "ServiceDeal" SET "requestedAt" = now() - interval '30 days' WHERE id IN ($1, $2)`,
      [young, old]
    );
    await q(`UPDATE "User" SET "createdAt" = now() - interval '35 days' WHERE id = 10`);
    await q(`UPDATE "User" SET "createdAt" = now() - interval '38 days' WHERE id = 11`);
    await review(young, 'Happy', 10);
    await review(old, 'Happy', 11);
    expect(await counters()).toEqual({ happyCount: 1, reviewCount: 1, happySortKey: -1 });
  });

  it("stops counting a buyer once banned or deleted, at the deals job's next recount", async () => {
    const banned = await completedBy(10);
    const deleted = await completedBy(11);
    await review(banned, 'Happy', 10);
    await review(deleted, 'Happy', 11);
    expect((await counters()).reviewCount).toBe(2);
    await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = 10`);
    await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = 11`);
    expect(
      await reconcile.reconcileServiceDealReviews({ limit: 10, counters: true })
    ).toMatchObject({ recounted: 1 });
    expect((await counters()).reviewCount).toBe(0);
  });

  it('does not count a review whose comment the check blocked, and recounts nothing on a repeat sync', async () => {
    const id = await completedBy();
    await review(id, 'Happy', BUYER, 'text');
    const [{ id: reviewId }] = await q<{ id: number }>(
      `UPDATE "ServiceDealReview" SET "scanStatus" = 'Blocked' WHERE "dealId" = $1 RETURNING id`,
      [id]
    );
    expect(await publish.syncReviewPublication(reviewId)).toBe(false);
    expect((await counters()).reviewCount).toBe(0);
    await q(`UPDATE "ServiceDealReview" SET "scanStatus" = 'Scanned' WHERE id = $1`, [reviewId]);
    expect(await publish.syncReviewPublication(reviewId)).toBe(true);
    expect(await publish.syncReviewPublication(reviewId)).toBe(false);
    expect((await counters()).reviewCount).toBe(1);
  });

  it('never shows a happy review of a deal refunded on dispute', async () => {
    const id = await completedBy();
    await review(id, 'Happy');
    await vi.waitFor(async () => expect((await deal(id)).settledAt).not.toBeNull());
    await q(
      `UPDATE "ServiceDeal" SET "disputeOpenedAt" = now(), "disputeResolution" = 'Refund',
         "disputeResolvedAt" = now(), "disputeResolvedById" = $2 WHERE id = $1`,
      [id, STRANGER]
    );
    await creatorServiceDealsJob.run();
    expect(await published(id)).toBeNull();
    expect((await counters()).happyCount).toBe(0);
  });

  it('unshows a happy review while a failed final holds the deal, and uncounts it', async () => {
    const id = await completedBy();
    await review(id, 'Happy');
    expect((await counters()).happyCount).toBe(1);
    // The early release runs in the background: let it land, then unwind it to the state where the
    // hold came first, so it cannot land after the edits below.
    await vi.waitFor(async () => expect((await deal(id)).settledAt).not.toBeNull());
    await q(`DELETE FROM "ServiceDealTransaction" WHERE "dealId" = $1 AND leg = 'Release'`, [id]);
    await q(`UPDATE "ServiceDeal" SET "settledAt" = NULL WHERE id = $1`, [id]);
    expect(await escrow.holdServiceDealForReview(id, escrow.FINAL_SCAN_FAILED)).toBe(true);
    expect(await published(id)).toBeNull();
    expect((await counters()).happyCount).toBe(0);
  });

  describe('edits, replies and hiding', () => {
    const reviewRow = async (dealId: number) =>
      (
        await q<{
          id: number;
          comment: string | null;
          scanStatus: string;
          sellerReply: string | null;
          sellerReplyScanStatus: string | null;
          publishedAt: Date | null;
          hiddenById: number | null;
        }>(
          `SELECT id, comment, "scanStatus"::text, "sellerReply", "sellerReplyScanStatus"::text,
             "publishedAt", "hiddenById" FROM "ServiceDealReview" WHERE "dealId" = $1`,
          [dealId]
        )
      )[0];
    const edit = (dealId: number, comment: string | null, userId = BUYER) =>
      dealReviews.editServiceDealReview({ dealId, userId, comment, reviewFlag: true });
    const reply = (dealId: number, text: string, userId = SELLER) =>
      dealReviews.replyToServiceDealReview({ dealId, userId, reply: text, reviewFlag: true });

    it('unshows an edited review until the new comment passes, and keeps the verdict', async () => {
      const id = await completedBy();
      await review(id, 'Happy');
      expect((await counters()).happyCount).toBe(1);
      await edit(id, 'Even better on a second look');
      expect(await reviewRow(id)).toMatchObject({ scanStatus: 'Pending', publishedAt: null });
      expect((await counters()).happyCount).toBe(0);
      // Clearing the comment leaves nothing to check.
      await edit(id, '  ');
      expect(await reviewRow(id)).toMatchObject({ comment: null, scanStatus: 'Scanned' });
      expect((await counters()).happyCount).toBe(1);
    });

    it('refuses an edit after the window, by someone else, or on a hidden review', async () => {
      const id = await completedBy();
      await review(id, 'NotQuite', BUYER, 'meh');
      await expect(edit(id, 'x', SELLER)).rejects.toEqual(conflict);
      await q(`UPDATE "ServiceDealReview" SET "hiddenAt" = now() WHERE "dealId" = $1`, [id]);
      await expect(edit(id, 'x')).rejects.toEqual(conflict);
      await q(
        `UPDATE "ServiceDealReview" SET "hiddenAt" = NULL, "editableUntil" = now() WHERE "dealId" = $1`,
        [id]
      );
      await expect(edit(id, 'x')).rejects.toEqual(conflict);
      expect((await reviewRow(id)).comment).toBe('meh');
    });

    it('keeps a comment the csam queue holds blocked whatever the buyer changes it to', async () => {
      const id = await completedBy();
      await review(id, 'Happy', BUYER, 'held text');
      const { id: reviewId } = await reviewRow(id);
      await q(`UPDATE "ServiceDealReview" SET "scanStatus" = 'Blocked' WHERE id = $1`, [reviewId]);
      await q(
        `INSERT INTO "TextScanHold" ("entityType", "entityId", label, "textHash", text, reason, status, "updatedAt")
         VALUES ('ServiceDealReview', $1, 'csam', 'h', 't', 'r', 'Confirmed', now())`,
        [reviewId]
      );
      await edit(id, 'something harmless');
      expect((await reviewRow(id)).scanStatus).toBe('Blocked');
    });

    it('lets the seller reply once, and sends the reply to its check', async () => {
      const id = await completedBy();
      await review(id, 'Happy');
      await expect(reply(id, 'thanks', BUYER)).rejects.toEqual(conflict);
      await reply(id, '  Thank you!  ');
      expect(await reviewRow(id)).toMatchObject({
        sellerReply: 'Thank you!',
        sellerReplyScanStatus: 'Pending',
      });
      await expect(reply(id, 'again')).rejects.toEqual(conflict);
    });

    it('writes nothing when the text guard refuses a comment, an edit or a reply', async () => {
      const guard = vi.mocked(throwOnBlockedUserContent);
      const blocked = new Error('blocked');
      const id = await completedBy();
      guard.mockRejectedValueOnce(blocked);
      await expect(review(id, 'NotQuite', BUYER, 'bad')).rejects.toBe(blocked);
      expect(await reviewRow(id)).toBeUndefined();
      await review(id, 'NotQuite', BUYER, 'fine');
      guard.mockRejectedValueOnce(blocked);
      await expect(edit(id, 'bad')).rejects.toBe(blocked);
      guard.mockRejectedValueOnce(blocked);
      await expect(reply(id, 'bad')).rejects.toBe(blocked);
      expect(await reviewRow(id)).toMatchObject({ comment: 'fine', sellerReply: null });
    });

    it('keeps a hidden review from the seller, and rechecks text whose scan was skipped while hidden', async () => {
      const id = await completedBy();
      await review(id, 'NotQuite', BUYER, 'words');
      const { id: reviewId } = await reviewRow(id);
      await q(`UPDATE "ServiceDealReview" SET "scanStatus" = 'Scanned' WHERE id = $1`, [reviewId]);
      const sellerSees = async () =>
        (
          await dealReviews.getDealReviewView({
            dealId: id,
            viewerRole: 'seller',
            servableLevels: 31,
          })
        )?.review;
      expect(await sellerSees()).toMatchObject({ comment: 'words', scanStatus: null });
      await dealReviews.setServiceDealReviewHidden({
        reviewId,
        moderatorId: STRANGER,
        hidden: true,
      });
      expect((await sellerSees())?.comment).toBeNull();
      // The scan was skipped while hidden and left the text in Error.
      await q(
        `UPDATE "ServiceDealReview" SET "scanStatus" = 'Error', "scanWorkflowId" = 'wf' WHERE id = $1`,
        [reviewId]
      );
      await dealReviews.setServiceDealReviewHidden({
        reviewId,
        moderatorId: STRANGER,
        hidden: false,
      });
      expect(await reviewRow(id)).toMatchObject({ scanStatus: 'Pending' });
    });

    // Only a CSAM or minor-sexualization report on the review opens a moderator's csam hold, and a
    // hold always takes the whole review down.
    describe("a moderator's csam hold from a report", () => {
      const reported = async (
        reason: string,
        details: Record<string, unknown> = {},
        comment: string | null = 'Lovely'
      ) => {
        const id = await completedBy();
        await review(id, 'Happy', BUYER, comment ?? undefined);
        const [{ id: reviewId }] = await q<{ id: number }>(
          `UPDATE "ServiceDealReview" SET "scanStatus" = 'Scanned' WHERE "dealId" = $1 RETURNING id`,
          [id]
        );
        await publish.syncReviewPublication(reviewId);
        const [{ id: reportId }] = await q<{ id: number }>(
          `INSERT INTO "Report" (reason, details) VALUES ($1, $2) RETURNING id`,
          [reason, JSON.stringify(details)]
        );
        await q(
          `INSERT INTO "ServiceDealReviewReport" ("reportId", "serviceDealReviewId", "serviceOfferingId")
           VALUES ($1, $2, 1)`,
          [reportId, reviewId]
        );
        return { id, reviewId, reportId };
      };
      const minor = { violation: 'Child abuse and exploitation' };
      const hold = (
        reviewId: number,
        reportId: number,
        type: 'ServiceDealReview' | 'ServiceDealReviewReply' | null = 'ServiceDealReview'
      ) =>
        reviewReports.holdReportedServiceDealReview({
          reviewId,
          type,
          moderatorId: STRANGER,
          reportId,
        });
      const holds = (reviewId: number) =>
        q<{ status: string; label: string }>(
          `SELECT status::text, label FROM "TextScanHold"
           WHERE "entityType" = 'ServiceDealReview' AND "entityId" = $1`,
          [reviewId]
        );
      const hiddenAt = async (reviewId: number) =>
        (
          await q<{ hiddenAt: Date | null }>(
            `SELECT "hiddenAt" FROM "ServiceDealReview" WHERE id = $1`,
            [reviewId]
          )
        )[0].hiddenAt;

      it('holds the comment of a review reported as a minor, and takes the review down', async () => {
        const { id, reviewId, reportId } = await reported('TOSViolation', minor);
        expect(await hold(reviewId, reportId)).toMatchObject({ changed: true });
        expect(await holds(reviewId)).toEqual([{ status: 'Pending', label: 'csam' }]);
        expect(await reviewRow(id)).toMatchObject({ scanStatus: 'Blocked', publishedAt: null });
        expect(await hiddenAt(reviewId)).not.toBeNull();
        expect(await hold(reviewId, reportId)).toMatchObject({ changed: false });
        expect(await holds(reviewId)).toHaveLength(1);
      });

      it('takes down a review with no text on a CSAM report, with no text hold', async () => {
        const { id, reviewId, reportId } = await reported('CSAM', {}, null);
        expect(await hold(reviewId, reportId)).toBe('pickText');
        expect(await hold(reviewId, reportId, null)).toEqual({ holdId: null, changed: true });
        expect((await reviewRow(id)).publishedAt).toBeNull();
        expect(await hiddenAt(reviewId)).not.toBeNull();
        expect(await holds(reviewId)).toEqual([]);
      });

      it('commits neither the hold nor the takedown when the takedown fails', async () => {
        const { id, reviewId, reportId } = await reported('CSAM');
        await holder.db.exec(`
          CREATE FUNCTION fail_review_update() RETURNS trigger LANGUAGE plpgsql AS
            $$ BEGIN RAISE EXCEPTION 'takedown failed'; END $$;
          CREATE TRIGGER fail_review_update BEFORE UPDATE ON "ServiceDealReview"
            FOR EACH ROW EXECUTE FUNCTION fail_review_update();
        `);
        try {
          await expect(hold(reviewId, reportId)).rejects.toThrow('takedown failed');
        } finally {
          await holder.db.exec(`
            DROP TRIGGER fail_review_update ON "ServiceDealReview";
            DROP FUNCTION fail_review_update();
          `);
        }
        expect(await holds(reviewId)).toEqual([]);
        expect((await reviewRow(id)).publishedAt).not.toBeNull();
      });

      it("sends the review's images to the CSAM review queue, filing no CsamReport", async () => {
        const { reviewId, reportId } = await reported('CSAM');
        const imageIds = (
          await q<{ id: number }>(`INSERT INTO "Image" (url) VALUES ('a'), ('b') RETURNING id`)
        ).map((r) => r.id);
        for (const imageId of imageIds)
          await q(`INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId") VALUES ($1, $2)`, [
            reviewId,
            imageId,
          ]);
        await holder.db.exec(`CREATE TABLE IF NOT EXISTS "CsamReport" (id serial PRIMARY KEY)`);
        expect(await hold(reviewId, reportId)).toMatchObject({ changed: true });
        expect(
          await q<{ needsReview: string | null }>(
            `SELECT "needsReview" FROM "Image" WHERE id = ANY($1::int[]) ORDER BY id`,
            [imageIds]
          )
        ).toEqual([{ needsReview: 'csam' }, { needsReview: 'csam' }]);
        expect(await q(`SELECT 1 FROM "CsamReport"`)).toEqual([]);
      });

      it("refreshes the home blocks showing the review's images", async () => {
        const { reviewId, reportId } = await reported('CSAM');
        const [{ id: imageId }] = await q<{ id: number }>(
          `INSERT INTO "Image" (url) VALUES ('a') RETURNING id`
        );
        await q(`INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId") VALUES ($1, $2)`, [
          reviewId,
          imageId,
        ]);
        dbMock.dbRead.$queryRaw.mockClear();
        await hold(reviewId, reportId);
        // The refresh's collection lookup, seen at the database: the image ids bound as one array.
        const lookedUp = dbMock.dbRead.$queryRaw.mock.calls
          .map(([query]) => query as unknown as { sql?: string; values?: unknown[] })
          .filter((query) => !!query?.sql?.includes('"CollectionItem"'))
          .flatMap((query) => (query.values ?? []).filter(Array.isArray));
        expect(lookedUp).toContainEqual([imageId]);
      });

      it('opens no hold from a report with another reason, or one on another review', async () => {
        const spam = await reported('Spam');
        expect(await hold(spam.reviewId, spam.reportId)).toBe('refused');
        const csam = await reported('CSAM');
        expect(await hold(spam.reviewId, csam.reportId)).toBe('refused');
        expect(await holds(spam.reviewId)).toEqual([]);
        expect((await reviewRow(spam.id)).publishedAt).not.toBeNull();
      });

      it('hides only on a report that is not CSAM, and restores only once the CSAM queue has decided', async () => {
        const setHidden = (reviewId: number, hidden: boolean, reportId?: number) =>
          reviewReports.setReportedServiceDealReviewHidden({
            reviewId,
            moderatorId: STRANGER,
            hidden,
            reportId,
          });
        const csam = await reported('TOSViolation', minor);
        expect(await setHidden(csam.reviewId, true, csam.reportId)).toBe('refused');
        expect(await hiddenAt(csam.reviewId)).toBeNull();
        await hold(csam.reviewId, csam.reportId);
        expect(await setHidden(csam.reviewId, false)).toBe('held');
        // The deal page's restore takes the same refusal, for a confirmed hold too.
        const restore = () =>
          dealReviews.setServiceDealReviewHidden({
            reviewId: csam.reviewId,
            moderatorId: STRANGER,
            hidden: false,
          });
        expect(await restore()).toBe('held');
        await q(`UPDATE "TextScanHold" SET status = 'Confirmed' WHERE "entityId" = $1`, [
          csam.reviewId,
        ]);
        expect(await restore()).toBe('held');
        expect(await hiddenAt(csam.reviewId)).not.toBeNull();
        await q(`UPDATE "TextScanHold" SET status = 'Dismissed' WHERE "entityId" = $1`, [
          csam.reviewId,
        ]);
        expect(await restore()).toBe(true);

        const spam = await reported('Spam');
        expect(await setHidden(spam.reviewId, true)).toBe('refused');
        expect(await setHidden(spam.reviewId, true, spam.reportId)).toBe(true);
        expect(await setHidden(spam.reviewId, false)).toBe(true);
      });
    });

    it('a moderator hides and restores a review, and the counters follow', async () => {
      const id = await completedBy();
      await review(id, 'Happy');
      const { id: reviewId } = await reviewRow(id);
      const hide = (hidden: boolean) =>
        dealReviews.setServiceDealReviewHidden({ reviewId, moderatorId: STRANGER, hidden });
      expect(await hide(true)).toBe(true);
      expect(await hide(true)).toBe(false);
      expect(await reviewRow(id)).toMatchObject({ publishedAt: null, hiddenById: STRANGER });
      expect((await counters()).happyCount).toBe(0);
      expect(await hide(false)).toBe(true);
      expect((await reviewRow(id)).publishedAt).not.toBeNull();
      expect((await counters()).happyCount).toBe(1);
    });
  });

  it("shows each party the other's text only once it passed its check", async () => {
    const id = await completedBy();
    await review(id, 'Happy', BUYER, 'From the buyer');
    await dealReviews.replyToServiceDealReview({
      dealId: id,
      userId: SELLER,
      reply: 'From the seller',
      reviewFlag: true,
    });
    const view = (viewerRole: 'buyer' | 'seller' | 'moderator') =>
      dealReviews.getDealReviewView({ dealId: id, viewerRole, servableLevels: 31 });
    expect((await view('buyer'))?.review).toMatchObject({
      comment: 'From the buyer',
      sellerReply: null,
    });
    expect((await view('seller'))?.review).toMatchObject({
      comment: null,
      sellerReply: 'From the seller',
    });
    expect((await view('moderator'))?.review).toMatchObject({
      comment: 'From the buyer',
      sellerReply: 'From the seller',
    });
    await q(
      `UPDATE "ServiceDealReview" SET "scanStatus" = 'Scanned', "sellerReplyScanStatus" = 'Scanned' WHERE "dealId" = $1`,
      [id]
    );
    expect((await view('seller'))?.review?.comment).toBe('From the buyer');
    expect((await view('buyer'))?.review?.sellerReply).toBe('From the seller');
    // A deal requested without the review flag has no card.
    const unenrolled = await completedBy(10);
    await q(`UPDATE "ServiceDeal" SET "reviewEnabledAt" = NULL WHERE id = $1`, [unenrolled]);
    expect(
      await dealReviews.getDealReviewView({
        dealId: unenrolled,
        viewerRole: 'buyer',
        servableLevels: 31,
      })
    ).toBeNull();
  });

  describe('the deals job', () => {
    const readBack = () => reconcile.readBackServiceDealReviews();
    const zero = { eventsWithoutReview: 0, unpaidHappy: 0, earlyRelease: 0 };

    it('reads back zero on a happy release, and flags each kind of mismatch', async () => {
      const id = await completedBy();
      await review(id, 'Happy');
      await escrow.sweepServiceDealReleases();
      expect(await readBack()).toEqual(zero);

      // Drifted counters are found and recounted by the hourly pass, and logged.
      await q(`UPDATE "ServiceOffering" SET "happyCount" = 5 WHERE id = 1`);
      expect(await reconcile.reconcileServiceDealReviews({ limit: 10 })).toMatchObject({
        recounted: 0,
      });
      expect(
        await reconcile.reconcileServiceDealReviews({ limit: 10, counters: true })
      ).toMatchObject({ recounted: 1 });
      expect((await counters()).happyCount).toBe(1);

      // A deal paid early with no happy review behind it.
      const early = await completedBy(10);
      await q(`UPDATE "ServiceDeal" SET "releaseAt" = "completedAt" WHERE id = $1`, [early]);
      expect((await readBack()).earlyRelease).toBe(1);
      await q(
        `UPDATE "ServiceDeal" SET "releaseAt" = "completedAt" + interval '48 hours' WHERE id = $1`,
        [early]
      );

      // A happy-review event whose review row is gone, on a deal left unpaid for an hour.
      const unpaid = await completedBy(11);
      await review(unpaid, 'Happy', 11);
      await vi.waitFor(async () => expect((await deal(unpaid)).settledAt).not.toBeNull());
      await q(`DELETE FROM "ServiceDealTransaction" WHERE "dealId" = $1 AND leg = 'Release'`, [
        unpaid,
      ]);
      await q(`UPDATE "ServiceDeal" SET "settledAt" = NULL WHERE id = $1`, [unpaid]);
      await q(
        `UPDATE "ServiceDealEvent" SET "createdAt" = now() - interval '1 hour' WHERE "dealId" = $1`,
        [unpaid]
      );
      await q(`DELETE FROM "ServiceDealReview" WHERE "dealId" = $1`, [unpaid]);
      expect(await readBack()).toMatchObject({ eventsWithoutReview: 1, unpaidHappy: 1 });
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'release-on-review read-back mismatch' })
      );
    });

    it('shows a review its deal now allows, and recounts', async () => {
      const id = await completedBy();
      await review(id, 'Happy');
      // Paid first (the review starts the payout), so nothing else in the job moves this review.
      await vi.waitFor(async () => expect((await deal(id)).settledAt).not.toBeNull());
      await q(`UPDATE "ServiceDealReview" SET "publishedAt" = NULL WHERE "dealId" = $1`, [id]);
      await q(`UPDATE "ServiceOffering" SET "happyCount" = 0, "reviewCount" = 0 WHERE id = 1`);
      await creatorServiceDealsJob.run();
      expect(await published(id)).not.toBeNull();
      expect((await counters()).happyCount).toBe(1);
    });

    it('sends a comment whose check was never recorded back to its check', async () => {
      const id = await completedBy();
      await review(id, 'NotQuite', BUYER, 'Not what I asked for');
      const [{ id: reviewId }] = await q<{ id: number }>(
        `UPDATE "ServiceDealReview" SET "scanWorkflowId" = NULL, "updatedAt" = now() - interval '1 hour'
         WHERE "dealId" = $1 RETURNING id`,
        [id]
      );
      const submitCheck = vi.fn(async () => null);
      // The scan can ask every label: the csam gate is open and its prompt is in the cache. The
      // content-check suite covers when it cannot.
      redisMock.sysRedis.hGetAll.mockResolvedValue({ csam: 'review' } as never);
      redisMock.redis.packed.get.mockImplementation((async (key: string) =>
        key === REDIS_KEYS.CACHES.TEXT_SCAN_PROMPTS
          ? {
              data: { 'label:csam': { id: 1, key: 'label:csam', content: 'CSAM DEF' } },
              cachedAt: Date.now(),
            }
          : null) as never);
      resetTextScanRolloutCache();
      try {
        await reconcile.reconcileServiceDealReviews({ limit: 10, submitCheck });
        expect(submitCheck.mock.calls).toEqual([
          [expect.objectContaining({ entityType: 'ServiceDealReview', entityId: reviewId })],
        ]);
        // A hidden review's skipped scan is not resent.
        submitCheck.mockClear();
        await q(`UPDATE "ServiceDealReview" SET "hiddenAt" = now() WHERE id = $1`, [reviewId]);
        await reconcile.reconcileServiceDealReviews({ limit: 10, submitCheck });
        expect(submitCheck).not.toHaveBeenCalled();
      } finally {
        redisMock.sysRedis.hGetAll.mockImplementation(async () => ({} as never));
        redisMock.redis.packed.get.mockImplementation(async () => null as never);
        resetTextScanRolloutCache();
      }
    });
  });
});

describe('dispute reviews', () => {
  const disputed = async (buyerId = BUYER, overrides: Parameters<typeof request>[0] = {}) => {
    const { id } = await request({ buyerId, ...overrides });
    await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
    await deliver(id);
    await deals.acceptServiceDealDelivery({ dealId: id, userId: buyerId });
    await deals.openServiceDealDispute({ dealId: id, userId: buyerId, reason: 'not as previewed' });
    return id;
  };
  // The opening the reviewer read, as an agent takes it from the evidence bundle.
  const openedAt = async (dealId: number) => {
    const { disputeOpenedAt } = (
      await reviews.getServiceDisputeEvidence({ dealId, viewerId: STRANGER })
    ).deal;
    if (!disputeOpenedAt) throw new Error(`deal ${dealId} has no dispute opening`);
    return disputeOpenedAt;
  };
  const review = async (
    dealId: number,
    proposal: 'Refund' | 'Release' | null,
    reviewerId = STRANGER,
    disputeOpenedAt?: Date
  ) =>
    reviews.createServiceDisputeReview({
      disputeOpenedAt: disputeOpenedAt ?? (await openedAt(dealId)),
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

  it("shows the reviewer the buyer's form answers and the price they gave", async () => {
    await q(`UPDATE "ServiceOffering" SET "requestForm" = $1::jsonb, "requestFormVersion" = 1`, [
      JSON.stringify({
        questions: [
          {
            type: 'pickOne',
            id: 'style',
            label: 'Style',
            options: [
              { id: 'sketch', label: 'Sketch', price: 0, days: 0 },
              { id: 'color', label: 'Full color', price: 300, days: 2 },
            ],
          },
        ],
      }),
    ]);
    buzz.createMultiAccountBuzzTransaction.mockResolvedValue(charged(800));
    const id = await disputed(BUYER, {
      expectedPrice: 800,
      expectedDeliveryDays: 5,
      formVersion: 1,
      formAnswers: { style: 'color' },
    });
    const { deal } = await reviews.getServiceDisputeEvidence({ dealId: id, viewerId: STRANGER });
    expect(deal).toMatchObject({
      price: 800,
      formAnswers: [{ label: 'Style', answer: 'Full color' }],
      priceBreakdown: [
        { label: 'Base', price: 500, days: 3 },
        { label: 'Full color', price: 300, days: 2 },
      ],
    });
  });

  it('shows no form answers for a deal requested without a form', async () => {
    const { deal } = await reviews.getServiceDisputeEvidence({
      dealId: await disputed(),
      viewerId: STRANGER,
    });
    expect(deal).toMatchObject({ formAnswers: null, priceBreakdown: null });
  });

  it('refuses a review of a deal that is not Disputed, and writes nothing', async () => {
    const { id } = await request();
    await expect(review(id, 'Refund', STRANGER, new Date())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
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
    const firstOpening = await openedAt(id);
    await resolve(id, 'Release');
    // As a payout that holds the deal again does: the dispute reopens with a new opening time.
    await q(
      `UPDATE "ServiceDeal" SET status = 'Disputed', "disputeResolution" = NULL,
         "disputeResolvedAt" = NULL, "disputeResolvedById" = NULL, "disputeOpenedAt" = now()
       WHERE id = $1`,
      [id]
    );
    expect(await latestOnQueue(id)).toBeNull();
    // A review built on the evidence of the first hold is refused, not scored against this one.
    await expect(review(id, 'Release', STRANGER, firstOpening)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/reopened/),
    });

    await review(id, null);
    await resolve(id, 'Release');
    expect(await rows(id)).toEqual([
      { proposal: 'Release', humanRuling: 'Release', humanId: STRANGER, agreed: true },
      { proposal: null, humanRuling: 'Release', humanId: STRANGER, agreed: null },
    ]);
  });

  it('accepts the current opening whatever the session time zone', async () => {
    const id = await disputed();
    const opening = await openedAt(id);
    // The stored column has no zone; the comparison must not borrow the session's.
    await q(`SET TIME ZONE 'Asia/Tokyo'`);
    try {
      await expect(review(id, 'Refund', STRANGER, opening)).resolves.toMatchObject({
        id: expect.any(Number),
      });
    } finally {
      await q(`SET TIME ZONE 'UTC'`);
    }
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
    // The access log could not be read: it reads as unknown, never as empty.
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

  it.each([
    ['missing', undefined, 'off'],
    ['shadow', 'shadow', 'shadow'],
    ['unknown', 'yes', 'off'],
  ])('reads the agent kill switch when it is %s', async (_, stored, expected) => {
    await q(`DELETE FROM "KeyValue" WHERE key = $1`, [reviews.DISPUTE_AGENT_MODE_KEY]);
    if (stored !== undefined)
      await q(`INSERT INTO "KeyValue" (key, value) VALUES ($1, $2::jsonb)`, [
        reviews.DISPUTE_AGENT_MODE_KEY,
        JSON.stringify(stored),
      ]);
    const id = await disputed();
    expect(
      (await reviews.getServiceDisputeEvidence({ dealId: id, viewerId: STRANGER })).agentMode
    ).toBe(expected);
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
