import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Buzz-purchased memberships earn the monthly badge (and nothing else they withhold).
 *
 * Runs the real delivery SQL against PGlite, through both ways a member gets it: at
 * purchase, and in the daily `deliverMonthlyCosmetics({})` run. The undated Supporter
 * Nameplate stays cash-only on purpose: a Buzz month is written with `cancelAt` NULL, so
 * the nightly revoke would never take a nameplate back once the month lapsed.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const buzz = vi.hoisted(() => ({
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...buzz,
}));
vi.mock('~/server/utils/subscription.utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateSubscriptionCaches: vi.fn(),
}));
vi.mock('~/server/integrations/freshdesk', () => ({ upsertContact: vi.fn() }));

const bridge = (kind: 'execute' | 'query') =>
  (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const result = await holder.db.query(flat.text, flat.values as unknown[]);
    return kind === 'execute' ? result.affectedRows ?? 0 : result.rows;
  }) as never;

const { deliverMonthlyCosmetics, purchaseMembershipWithBuzz, unlockPrepaidTokensForDate } =
  await import('~/server/services/subscriptions.service');

const CASH_BRONZE = 'civitai-bronze';
const CASH_SILVER = 'civitai-silver';
const BUZZ_BRONZE = 'civitai-buzz-bronze';
const BUZZ_SILVER = 'civitai-buzz-silver';

const CUR_BRONZE = 101; // this month's badges
const CUR_SILVER = 102;
const PREV_BRONZE = 103; // last month's
const NAMEPLATE = 201; // undated Supporter Nameplate
const DATED_ITEM = 202; // dated this month, but not a badge
const OPEN_ENDED_BADGE = 203; // a badge with no end date

const CASH_MEMBER = 1;
const BUZZ_MEMBER = 2; // bought before this month's badge opened
const BUZZ_SILVER_MEMBER = 3;
const BUZZ_ENDS_TODAY = 4;
const BUZZ_LAPSED = 5;
const BUYER = 6;

// Buzz catalog metadata as prod holds it (replica, 2026-10-22): `monthlyBuzz: 0` present,
// the cash tier's badgeType, multipliers "1". Silver uses the seed script's shape instead (no
// monthlyBuzz key) so both shapes stay covered.
const buzzMeta = (tier: string, level: number, { seedShape = false } = {}) =>
  JSON.stringify({
    tier,
    level,
    buzzPurchase: true,
    badgeType: 'static',
    purchasesMultiplier: '1',
    rewardsMultiplier: '1',
    ...(seedShape ? {} : { monthlyBuzz: 0 }),
  });

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Product" (id text PRIMARY KEY, provider text NOT NULL, active boolean NOT NULL, metadata jsonb NOT NULL);
    CREATE TABLE "Price" (id text PRIMARY KEY);
    CREATE TABLE "CustomerSubscription" (
      id text PRIMARY KEY,
      "userId" int NOT NULL,
      "productId" text NOT NULL,
      "priceId" text NOT NULL,
      status text NOT NULL,
      "currentPeriodStart" timestamp(3) NOT NULL,
      "currentPeriodEnd" timestamp(3) NOT NULL,
      "createdAt" timestamp(3) NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}',
      "updatedAt" timestamp(3)
    );
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, "productId" text, "availableStart" timestamp(3), "availableEnd" timestamp(3), type text NOT NULL);
    CREATE TABLE "UserCosmetic" (
      "userId" int NOT NULL,
      "cosmeticId" int NOT NULL,
      "obtainedAt" timestamp(3),
      "claimKey" text NOT NULL,
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    INSERT INTO "Price" VALUES ('p-cash-bronze'), ('p-buzz-bronze'), ('p-buzz-silver');
    INSERT INTO "Product" VALUES
      ('${CASH_BRONZE}', 'Civitai', true, '{"tier": "bronze", "level": 1, "monthlyBuzz": 10000, "badgeType": "static"}'),
      ('${CASH_SILVER}', 'Civitai', true, '{"tier": "silver", "level": 2, "monthlyBuzz": 25000, "badgeType": "static"}'),
      ('${BUZZ_BRONZE}', 'Civitai', true, '${buzzMeta('bronze', 1)}'),
      ('${BUZZ_SILVER}', 'Civitai', true, '${buzzMeta('silver', 2, { seedShape: true })}');
  `);
});

const sub = (
  id: string,
  userId: number,
  productId: string,
  priceId: string,
  start: string,
  end: string,
  metadata = '{}'
) =>
  `('${id}', ${userId}, '${productId}', '${priceId}', 'active', ${start}, ${end}, ${start}, '${metadata}')`;

const MONTH_START = `date_trunc('month', now())`;

beforeEach(async () => {
  vi.clearAllMocks();
  dbMock.dbWrite.$executeRaw.mockImplementation(bridge('execute'));
  dbMock.dbWrite.$queryRaw.mockImplementation(bridge('query'));

  await holder.db.exec(`
    TRUNCATE "CustomerSubscription", "Cosmetic", "UserCosmetic";
    INSERT INTO "Cosmetic" VALUES
      (${CUR_BRONZE}, '${CASH_BRONZE}', ${MONTH_START} + interval '11 hours', ${MONTH_START} + interval '1 month' - interval '1 day', 'Badge'),
      (${CUR_SILVER}, '${CASH_SILVER}', ${MONTH_START} + interval '11 hours', ${MONTH_START} + interval '1 month' - interval '1 day', 'Badge'),
      (${PREV_BRONZE}, '${CASH_BRONZE}', ${MONTH_START} - interval '1 month' + interval '11 hours', ${MONTH_START} - interval '1 day', 'Badge'),
      (${NAMEPLATE}, '${CASH_BRONZE}', NULL, NULL, 'Badge'),
      (${DATED_ITEM}, '${CASH_BRONZE}', ${MONTH_START} + interval '11 hours', ${MONTH_START} + interval '1 month' - interval '1 day', 'ProfileDecoration'),
      (${OPEN_ENDED_BADGE}, '${CASH_BRONZE}', ${MONTH_START} + interval '11 hours', NULL, 'Badge');
    INSERT INTO "CustomerSubscription" (id, "userId", "productId", "priceId", status, "currentPeriodStart", "currentPeriodEnd", "createdAt", metadata) VALUES
      ${sub(
        's-cash',
        CASH_MEMBER,
        CASH_BRONZE,
        'p-cash-bronze',
        `${MONTH_START} - interval '5 days'`,
        `${MONTH_START} + interval '25 days' + interval '2 months'`
      )},
      ${sub(
        's-buzz',
        BUZZ_MEMBER,
        BUZZ_BRONZE,
        'p-buzz-bronze',
        `${MONTH_START} - interval '5 days'`,
        `${MONTH_START} + interval '1 month' + interval '25 days'`
      )},
      ${sub(
        's-buzz-silver',
        BUZZ_SILVER_MEMBER,
        BUZZ_SILVER,
        'p-buzz-silver',
        `${MONTH_START} - interval '5 days'`,
        `${MONTH_START} + interval '1 month' + interval '25 days'`
      )},
      ${sub(
        's-buzz-today',
        BUZZ_ENDS_TODAY,
        BUZZ_BRONZE,
        'p-buzz-bronze',
        `date_trunc('day', now()) - interval '1 month'`,
        `date_trunc('day', now()) + interval '23 hours 59 minutes'`
      )},
      ${sub(
        's-buzz-lapsed',
        BUZZ_LAPSED,
        BUZZ_BRONZE,
        'p-buzz-bronze',
        `now() - interval '40 days'`,
        `now() - interval '10 days'`
      )};
  `);
});

const badgesOf = async (userId: number) =>
  (
    await holder.db.query<{ cosmeticId: number }>(
      `SELECT "cosmeticId" FROM "UserCosmetic" WHERE "userId" = $1 ORDER BY "cosmeticId"`,
      [userId]
    )
  ).rows.map((r) => r.cosmeticId);

describe('monthly delivery (deliverMonthlyCosmetics)', () => {
  it("gives a Buzz member this month's badge for their tier, whenever their period began", async () => {
    await deliverMonthlyCosmetics({});
    expect(await badgesOf(BUZZ_MEMBER)).toEqual([CUR_BRONZE]);
    expect(await badgesOf(BUZZ_SILVER_MEMBER)).toEqual([CUR_BRONZE, CUR_SILVER]);
  });

  // Decision (Justin, 2026-10-22): Buzz memberships get the monthly badge ONLY. Nothing is
  // ever revoked from a Buzz month (cancelAt is NULL on those rows), so loosening this guard
  // hands out permanent cosmetics. Do not "simplify" it away.
  it('gives a Buzz member only the dated monthly badge, and a cash member everything as before', async () => {
    await deliverMonthlyCosmetics({});
    expect(await badgesOf(BUZZ_MEMBER)).toEqual([CUR_BRONZE]);
    expect(await badgesOf(CASH_MEMBER)).toEqual([
      CUR_BRONZE,
      NAMEPLATE,
      DATED_ITEM,
      OPEN_ENDED_BADGE,
    ]);
  });

  it('gives nothing to a Buzz month that ends today or has lapsed', async () => {
    await deliverMonthlyCosmetics({});
    expect(await badgesOf(BUZZ_ENDS_TODAY)).toEqual([]);
    expect(await badgesOf(BUZZ_LAPSED)).toEqual([]);
  });

  it('is idempotent', async () => {
    await deliverMonthlyCosmetics({});
    const after = (await holder.db.query(`SELECT 1 FROM "UserCosmetic"`)).rows.length;
    await deliverMonthlyCosmetics({});
    expect((await holder.db.query(`SELECT 1 FROM "UserCosmetic"`)).rows.length).toBe(after);
  });
});

describe('purchase (purchaseMembershipWithBuzz)', () => {
  beforeEach(() => {
    buzz.createBuzzTransaction.mockResolvedValue({ transactionId: 'tx-1' });
    dbMock.dbWrite.price.findFirst.mockResolvedValue({
      id: 'p-buzz-bronze',
      interval: 'month',
      intervalCount: 1,
      unitAmount: 1000,
      product: {
        id: BUZZ_BRONZE,
        name: 'Bronze',
        metadata: JSON.parse(buzzMeta('bronze', 1)),
        provider: 'Civitai',
        active: true,
      },
    });
    dbMock.dbWrite.user.findFirst.mockResolvedValue({
      id: BUYER,
      username: 'buyer',
      email: 'buyer@example.com',
    });
    // The purchase's transaction is its own client, and the only one that sees the row it
    // writes: outside it, the uncommitted subscription does not exist yet. So a delivery
    // made on dbWrite instead of `tx` inserts nothing, as it would in Postgres.
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0 as never);
    const upsert = async ({ create }: { create: Record<string, unknown> }) => {
      await holder.db.query(
        `INSERT INTO "CustomerSubscription" (id, "userId", "productId", "priceId", status, "currentPeriodStart", "currentPeriodEnd", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          create.id,
          create.userId,
          create.productId,
          create.priceId,
          create.status,
          create.currentPeriodStart,
          create.currentPeriodEnd,
          create.createdAt,
        ]
      );
      return create;
    };
    const tx = {
      customerSubscription: { findFirst: async () => null, upsert },
      $executeRaw: bridge('execute'),
    };
    dbMock.dbWrite.$transaction.mockImplementationOnce((async (fn: (client: unknown) => unknown) =>
      fn(tx)) as never);
  });

  it("gives this month's badge at purchase", async () => {
    await purchaseMembershipWithBuzz({
      userId: BUYER,
      priceId: 'p-buzz-bronze',
      buzzType: 'green',
    });
    expect(await badgesOf(BUYER)).toEqual([CUR_BRONZE]);
  });

  it('moves Buzz once: the debit, at the 1.25x premium, and grants none back', async () => {
    await purchaseMembershipWithBuzz({
      userId: BUYER,
      priceId: 'p-buzz-bronze',
      buzzType: 'green',
    });
    expect(buzz.createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(buzz.createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: BUYER, toAccountId: 0, amount: 12_500 })
    );
  });
});

describe('monthly Buzz stays withheld (unlockPrepaidTokensForDate)', () => {
  it("unlocks a cash member's token on their anniversary, and never a Buzz member's", async () => {
    // A fixed mid-month noon: the unlock matches on day of month (in local time), so a
    // now()-relative start would miss on the 29th-31st and near midnight off UTC.
    const date = new Date('2026-10-15T12:00:00Z');
    const tokens = (tier: string) =>
      JSON.stringify({
        tokens: [{ id: `t-${tier}`, tier, status: 'locked', buzzAmount: 10000 }],
      });
    await holder.db.exec(`
      TRUNCATE "CustomerSubscription";
      INSERT INTO "CustomerSubscription" (id, "userId", "productId", "priceId", status, "currentPeriodStart", "currentPeriodEnd", "createdAt", metadata) VALUES
        ${sub(
          's-cash',
          CASH_MEMBER,
          CASH_BRONZE,
          'p-cash-bronze',
          `'2026-09-15 08:00'`,
          `'2026-12-15 08:00'`,
          tokens('bronze')
        )},
        ${sub(
          's-buzz',
          BUZZ_MEMBER,
          BUZZ_BRONZE,
          'p-buzz-bronze',
          `'2026-09-15 08:00'`,
          `'2026-11-01 08:00'`,
          tokens('bronze')
        )};
    `);
    const result = await unlockPrepaidTokensForDate({ date });
    expect(result.matched).toBe(1);
    const unlocked = await holder.db.query<{ id: string }>(
      `SELECT id FROM "CustomerSubscription" WHERE metadata->'tokens'->0->>'status' = 'unlocked'`
    );
    expect(unlocked.rows.map((r) => r.id)).toEqual(['s-cash']);
  });
});
