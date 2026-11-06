import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

dbMock.dbWrite.$executeRaw.mockImplementation((async (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  const { affectedRows } = await holder.db.query(flat.text, flat.values as unknown[]);
  return affectedRows ?? 0;
}) as never);
// The revoke returns the rows it deleted, so it is a query rather than an execute.
dbMock.dbWrite.$queryRaw.mockImplementation((async (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  const { rows } = await holder.db.query(flat.text, flat.values as unknown[]);
  return rows;
}) as never);

const { deliverMembershipCosmetics, NO_CANCEL_AT_REVOKE_FROM } = await import(
  '~/server/jobs/deliver-purchased-cosmetics'
);

const BRONZE = 'stripe-bronze';
const SILVER = 'stripe-silver';
const OTHER_PROVIDER_BRONZE = 'other-provider-bronze';
const OTHER_PROVIDER_SILVER = 'other-provider-silver';
const CIVITAI_BRONZE = 'civitai-bronze';
const CIVITAI_BUZZ_BRONZE = 'civitai-buzz-bronze'; // bought with Buzz; copies civitai-bronze's level
const FOUNDER = 'founder';
const RETIRED_BRONZE = 'retired-bronze'; // a lower tier that is no longer sold

const SEP_BRONZE = 91;
const SEP_SILVER = 92;
const OCT_BRONZE = 101;
const OCT_SILVER = 102;
const OTHER_PROVIDER_OCT_BRONZE = 103;
const CIVITAI_SEP_BRONZE = 94;
const CIVITAI_OCT_BRONZE = 104;
const PERMANENT_BADGE = 200;
const NON_MEMBERSHIP_ITEM = 201; // not permanent, but not a Membership cosmetic either
const NAMEPLATE = 300; // Supporter Nameplate: Bronze product, no window, not permanent
const CIVITAI_NAMEPLATE = 301;
const UNDATED_PURCHASE_ITEM = 302; // a non-membership cosmetic on a subscribed product
const GRANDFATHER = 400;
const RETIRED_OCT_BRONZE = 105;
const OPEN_ENDED_SILVER = 106; // dated start, no end

const ONTIME = 1; // Silver, renewed mid-October
const LATE = 2; // Bronze, period started Sep 28, invoice paid Oct 8
const RETURNING = 3; // active Bronze now, plus an old canceled subscription from another provider
const LAPSED = 4; // canceled before its period ran out, nothing active
const UNRENEWED = 5; // Bronze, period started Sep 20 and still running
const EXPIRED = 6; // row still says active, but its period ended and it was set to cancel
const FIRST_OF_MONTH = 7; // Bronze, renewed at 00:30 on Oct 1, before the badge's 07:00 start
const LAST_OF_MONTH = 8; // Bronze, renewed at 12:00 on Sep 30, after the badge's 07:00 end
const CIVITAI_PREPAID = 9; // Civitai prepaid period that started in September
const CIVITAI_RENEWED = 10; // Civitai period that started this month
const FOUNDER_MEMBER = 11; // active founder plus an active Bronze
const TRIALING = 12; // trialing now, plus an old canceled subscription
const CANCELING = 13; // canceled, cancelAt after the previous run
const STALE_ACTIVE = 14; // row still says active, period ended, never set to cancel
const NOT_STARTED = 15; // period starts after this run
const FOUNDER_ONLY = 16; // active founder, no tier subscription
const FOUNDER_CANCELED = 17; // canceled founder, active tier
const PAST_DUE = 18; // renewal payment being retried, period current, plus an old canceled subscription
const PAST_DUE_ENDED = 19; // past_due, period already ended, plus an old canceled subscription
const BUZZ_MEMBER = 20; // Buzz-purchased Civitai membership that started this month

const NOW = new Date('2026-10-08T23:00:00Z');
const LAST_DELIVERED = new Date('2026-10-07T23:00:00Z');

const sub = (
  id: string,
  userId: number,
  productId: string,
  status: string,
  start: string,
  end: string,
  cancelAt: string | null = null
) =>
  `('${id}', ${userId}, '${productId}', '${status}', '${start}', '${end}', '2026-01-01', ${
    cancelAt ? `'${cancelAt}'` : 'NULL'
  })`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Product" (id text PRIMARY KEY, provider text NOT NULL, active boolean NOT NULL, metadata jsonb NOT NULL);
    CREATE TABLE "CustomerSubscription" (
      id text PRIMARY KEY,
      "userId" int NOT NULL,
      "productId" text NOT NULL,
      status text NOT NULL,
      "currentPeriodStart" timestamp(3) NOT NULL,
      "currentPeriodEnd" timestamp(3) NOT NULL,
      "createdAt" timestamp(3) NOT NULL,
      "cancelAt" timestamp(3),
      "cancelAtPeriodEnd" boolean NOT NULL DEFAULT false,
      "endedAt" timestamp(3),
      "canceledAt" timestamp(3)
    );
    CREATE TABLE "Cosmetic" (
      id int PRIMARY KEY,
      name text NOT NULL,
      source text NOT NULL,
      "permanentUnlock" boolean NOT NULL,
      "productId" text,
      "availableStart" timestamp(3),
      "availableEnd" timestamp(3)
    );
    CREATE TABLE "UserCosmetic" (
      "userId" int NOT NULL,
      "cosmeticId" int NOT NULL,
      "obtainedAt" timestamp(3),
      "claimKey" text NOT NULL DEFAULT 'claimed',
      "equippedAt" timestamp(3),
      "equippedToId" int,
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    INSERT INTO "Product" VALUES
      ('${BRONZE}', 'Stripe', true, '{"level": 1, "tier": "bronze"}'),
      ('${SILVER}', 'Stripe', true, '{"level": 2, "tier": "silver"}'),
      ('${OTHER_PROVIDER_BRONZE}', 'Paddle', true, '{"level": 1, "tier": "bronze"}'),
      ('${OTHER_PROVIDER_SILVER}', 'Paddle', true, '{"level": 2, "tier": "silver"}'),
      ('${CIVITAI_BRONZE}', 'Civitai', true, '{"level": 1, "tier": "bronze"}'),
      ('${CIVITAI_BUZZ_BRONZE}', 'Civitai', true, '{"level": 1, "tier": "bronze", "buzzPurchase": true}'),
      ('${FOUNDER}', 'Stripe', false, '{"tier": "founder"}'),
      ('${RETIRED_BRONZE}', 'Stripe', false, '{"level": 1, "tier": "bronze"}');
  `);
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "CustomerSubscription", "Cosmetic", "UserCosmetic";
    INSERT INTO "Cosmetic" VALUES
      (${SEP_BRONZE}, 'Sep Bronze', 'Membership', false, '${BRONZE}', '2026-09-01 07:00', '2026-09-30 07:00'),
      (${SEP_SILVER}, 'Sep Silver', 'Membership', false, '${SILVER}', '2026-09-01 07:00', '2026-09-30 07:00'),
      (${OCT_BRONZE}, 'Oct Bronze', 'Membership', false, '${BRONZE}', '2026-10-01 07:00', '2026-10-31 07:00'),
      (${OCT_SILVER}, 'Oct Silver', 'Membership', false, '${SILVER}', '2026-10-01 07:00', '2026-10-31 07:00'),
      (${OTHER_PROVIDER_OCT_BRONZE}, 'Oct Bronze', 'Membership', false, '${OTHER_PROVIDER_BRONZE}', '2026-10-01 07:00', '2026-10-31 07:00'),
      (${CIVITAI_SEP_BRONZE}, 'Sep Bronze', 'Membership', false, '${CIVITAI_BRONZE}', '2026-09-01 07:00', '2026-09-30 07:00'),
      (${CIVITAI_OCT_BRONZE}, 'Oct Bronze', 'Membership', false, '${CIVITAI_BRONZE}', '2026-10-01 07:00', '2026-10-31 07:00'),
      (${PERMANENT_BADGE}, 'Keepsake', 'Membership', true, NULL, NULL, NULL),
      (${NON_MEMBERSHIP_ITEM}, 'Event item', 'Event', false, NULL, NULL, NULL),
      (${NAMEPLATE}, 'Supporter Nameplate', 'Membership', false, '${BRONZE}', NULL, NULL),
      (${CIVITAI_NAMEPLATE}, 'Supporter Nameplate', 'Membership', false, '${CIVITAI_BRONZE}', NULL, NULL),
      (${UNDATED_PURCHASE_ITEM}, 'Donator Nameplate', 'Purchase', true, '${BRONZE}', NULL, NULL),
      (${GRANDFATHER}, 'Grandfather Badge', 'Membership', true, NULL, NULL, NULL),
      (${RETIRED_OCT_BRONZE}, 'Oct Bronze', 'Membership', false, '${RETIRED_BRONZE}', '2026-10-01 07:00', '2026-10-31 07:00'),
      (${OPEN_ENDED_SILVER}, 'Silver forever', 'Membership', true, '${SILVER}', '2026-10-01 07:00', NULL);
    INSERT INTO "CustomerSubscription" VALUES
      ${sub('s-ontime', ONTIME, SILVER, 'active', '2026-10-05 10:00', '2026-11-05 10:00')},
      ${sub('s-late', LATE, BRONZE, 'active', '2026-09-28 12:00', '2026-10-28 12:00')},
      ${sub('s-returning', RETURNING, BRONZE, 'active', '2026-10-03 09:00', '2026-11-03 09:00')},
      ${sub(
        's-returning-old',
        RETURNING,
        OTHER_PROVIDER_SILVER,
        'canceled',
        '2025-04-01',
        '2025-05-01',
        '2025-05-01'
      )},
      ${sub('s-lapsed', LAPSED, BRONZE, 'canceled', '2026-09-15', '2026-10-15', '2026-09-20')},
      ${sub('s-unrenewed', UNRENEWED, BRONZE, 'active', '2026-09-20 08:00', '2026-10-20 08:00')},
      ${sub(
        's-expired',
        EXPIRED,
        BRONZE,
        'active',
        '2026-08-10 08:00',
        '2026-09-10 08:00',
        '2026-09-10 08:00'
      )},
      ${sub('s-first', FIRST_OF_MONTH, BRONZE, 'active', '2026-10-01 00:30', '2026-11-01 00:30')},
      ${sub('s-last', LAST_OF_MONTH, BRONZE, 'active', '2026-09-30 12:00', '2026-10-30 12:00')},
      ${sub(
        's-civ-prepaid',
        CIVITAI_PREPAID,
        CIVITAI_BRONZE,
        'active',
        '2026-09-05 08:00',
        '2027-09-05 08:00'
      )},
      ${sub(
        's-civ-renewed',
        CIVITAI_RENEWED,
        CIVITAI_BRONZE,
        'active',
        '2026-10-05 08:00',
        '2026-11-05 08:00'
      )},
      ${sub(
        's-founder',
        FOUNDER_MEMBER,
        FOUNDER,
        'active',
        '2026-10-01 00:00',
        '2026-11-01 00:00'
      )},
      ${sub(
        's-founder-bronze',
        FOUNDER_MEMBER,
        OTHER_PROVIDER_BRONZE,
        'active',
        '2026-10-02 00:00',
        '2026-11-02 00:00'
      )},
      ${sub('s-trialing', TRIALING, BRONZE, 'trialing', '2026-10-06 00:00', '2026-10-13 00:00')},
      ${sub(
        's-trialing-old',
        TRIALING,
        OTHER_PROVIDER_SILVER,
        'canceled',
        '2025-04-01',
        '2025-05-01',
        '2025-05-01'
      )},
      ${sub(
        's-canceling',
        CANCELING,
        BRONZE,
        'canceled',
        '2026-09-08 00:00',
        '2026-10-08 00:00',
        '2026-10-08 10:00'
      )},
      ${sub('s-stale', STALE_ACTIVE, BRONZE, 'active', '2026-09-02 00:00', '2026-10-02 00:00')},
      ${sub(
        's-not-started',
        NOT_STARTED,
        BRONZE,
        'active',
        '2026-10-09 00:00',
        '2026-11-09 00:00'
      )},
      ${sub(
        's-founder-only',
        FOUNDER_ONLY,
        FOUNDER,
        'active',
        '2026-10-01 00:00',
        '2026-11-01 00:00'
      )},
      ${sub(
        's-founder-canceled',
        FOUNDER_CANCELED,
        FOUNDER,
        'canceled',
        '2025-01-01 00:00',
        '2025-02-01 00:00'
      )},
      ${sub(
        's-founder-canceled-tier',
        FOUNDER_CANCELED,
        OTHER_PROVIDER_BRONZE,
        'active',
        '2026-10-02 00:00',
        '2026-11-02 00:00'
      )},
      ${sub('s-past-due', PAST_DUE, BRONZE, 'past_due', '2026-09-25 00:00', '2026-10-25 00:00')},
      ${sub(
        's-past-due-old',
        PAST_DUE,
        OTHER_PROVIDER_SILVER,
        'canceled',
        '2025-04-01',
        '2025-05-01',
        '2025-05-01'
      )},
      ${sub(
        's-past-due-ended',
        PAST_DUE_ENDED,
        BRONZE,
        'past_due',
        '2026-09-05 00:00',
        '2026-10-05 00:00'
      )},
      ${sub(
        's-buzz',
        BUZZ_MEMBER,
        CIVITAI_BUZZ_BRONZE,
        'active',
        '2026-10-04 00:00',
        '2026-11-04 00:00'
      )},
      ${sub(
        's-past-due-ended-old',
        PAST_DUE_ENDED,
        OTHER_PROVIDER_SILVER,
        'canceled',
        '2025-04-01',
        '2025-05-01',
        '2025-05-01'
      )};
    INSERT INTO "UserCosmetic" ("userId", "cosmeticId") VALUES
      (${RETURNING}, ${OCT_BRONZE}),
      (${LAPSED}, ${SEP_BRONZE}),
      (${LAPSED}, ${NAMEPLATE}),
      (${LAPSED}, ${PERMANENT_BADGE}),
      (${LAPSED}, ${NON_MEMBERSHIP_ITEM}),
      (${UNRENEWED}, ${SEP_BRONZE}),
      (${EXPIRED}, ${SEP_BRONZE}),
      (${TRIALING}, ${SEP_BRONZE}),
      (${CANCELING}, ${SEP_BRONZE}),
      (${PAST_DUE}, ${SEP_BRONZE}),
      (${PAST_DUE_ENDED}, ${SEP_BRONZE});
  `);
});

const badgesOf = async (userId: number) =>
  (
    await holder.db.query<{ cosmeticId: number }>(
      `SELECT "cosmeticId" FROM "UserCosmetic" WHERE "userId" = $1 ORDER BY "cosmeticId"`,
      [userId]
    )
  ).rows.map((r) => r.cosmeticId);

const run = (now = NOW, lastDelivered = LAST_DELIVERED) =>
  deliverMembershipCosmetics({ now, lastDelivered });

describe('deliverMembershipCosmetics', () => {
  describe('delivery', () => {
    it("grants the month of the current period, for the member's tier and every lower tier still sold by the same provider", async () => {
      await run();
      expect(await badgesOf(ONTIME)).toEqual([
        OCT_BRONZE,
        OCT_SILVER,
        OPEN_ENDED_SILVER,
        NAMEPLATE,
      ]);
    });

    it('grants the badge for the month a period started in, when payment lands in the next month', async () => {
      await run();
      expect(await badgesOf(LATE)).toEqual([SEP_BRONZE, NAMEPLATE]);
    });

    it('does not grant a month the current period did not start in', async () => {
      await run();
      expect(await badgesOf(UNRENEWED)).toEqual([SEP_BRONZE, NAMEPLATE]);
    });

    it('grants nothing for a period that has ended or not yet started', async () => {
      await run();
      expect(await badgesOf(STALE_ACTIVE)).toEqual([]);
      expect(await badgesOf(NOT_STARTED)).toEqual([]);
    });

    it('counts a period starting on the first before the badge opens as that month', async () => {
      await run();
      expect(await badgesOf(FIRST_OF_MONTH)).toEqual([OCT_BRONZE, NAMEPLATE]);
    });

    it('counts a period starting on the last day after the badge closes as that month', async () => {
      await run();
      expect(await badgesOf(LAST_OF_MONTH)).toEqual([SEP_BRONZE, NAMEPLATE]);
    });

    it('gives a Civitai membership only badges from the current month', async () => {
      await run();
      expect(await badgesOf(CIVITAI_PREPAID)).toEqual([]);
      expect(await badgesOf(CIVITAI_RENEWED)).toEqual([CIVITAI_OCT_BRONZE]);
    });

    it('grants the Grandfather Badge to an active founder with an active tier, and to no one else', async () => {
      await run();
      expect(await badgesOf(FOUNDER_MEMBER)).toEqual([OTHER_PROVIDER_OCT_BRONZE, GRANDFATHER]);
      expect(await badgesOf(ONTIME)).not.toContain(GRANDFATHER);
      expect(await badgesOf(FOUNDER_ONLY)).toEqual([]);
      expect(await badgesOf(FOUNDER_CANCELED)).toEqual([OTHER_PROVIDER_OCT_BRONZE]);
    });

    it('is idempotent, including on the following night', async () => {
      await run();
      const after = (await holder.db.query(`SELECT 1 FROM "UserCosmetic"`)).rows.length;
      await run();
      expect((await holder.db.query(`SELECT 1 FROM "UserCosmetic"`)).rows.length).toBe(after);

      await run(new Date('2026-10-09T23:00:00Z'), NOW);
      expect(await badgesOf(ONTIME)).toEqual([
        OCT_BRONZE,
        OCT_SILVER,
        OPEN_ENDED_SILVER,
        NAMEPLATE,
      ]);
      expect(await badgesOf(LATE)).toEqual([SEP_BRONZE, NAMEPLATE]);
    });
  });

  describe('undated cosmetics', () => {
    it('leaves Civitai memberships to the monthly delivery, so a Buzz-bought one gets no nameplate through the level join', async () => {
      await run();
      expect(await badgesOf(ONTIME)).toContain(NAMEPLATE);
      expect(await badgesOf(CIVITAI_RENEWED)).toEqual([CIVITAI_OCT_BRONZE]);
      expect(await badgesOf(BUZZ_MEMBER)).not.toContain(CIVITAI_NAMEPLATE);
    });

    it('grants only membership cosmetics', async () => {
      await run();
      expect(await badgesOf(LATE)).toContain(NAMEPLATE);
      expect(await badgesOf(LATE)).not.toContain(UNDATED_PURCHASE_ITEM);
    });
  });

  describe('revoke', () => {
    it('keeps the badges of an active member who also has an old canceled subscription', async () => {
      await run();
      expect(await badgesOf(RETURNING)).toEqual([OCT_BRONZE, NAMEPLATE]);
    });

    it('keeps the badges of a trialing member who also has an old canceled subscription', async () => {
      await run();
      expect(await badgesOf(TRIALING)).toEqual([SEP_BRONZE]);
    });

    it('keeps the badges of a past_due member whose period is current, but not once it has ended', async () => {
      await run();
      expect(await badgesOf(PAST_DUE)).toEqual([SEP_BRONZE]);
      expect(await badgesOf(PAST_DUE_ENDED)).toEqual([]);
    });

    it('revokes non-permanent membership badges from a member with nothing active, and only those', async () => {
      await run();
      expect(await badgesOf(LAPSED)).toEqual([PERMANENT_BADGE, NON_MEMBERSHIP_ITEM]);
    });

    it('revokes from a member whose only "active" row has a period that already ended', async () => {
      await run();
      expect(await badgesOf(EXPIRED)).toEqual([]);
    });

    it('revokes on the first run after a cancellation takes effect, not before', async () => {
      await run();
      expect(await badgesOf(CANCELING)).toEqual([SEP_BRONZE]);
      await run(new Date('2026-10-09T23:00:00Z'), NOW);
      expect(await badgesOf(CANCELING)).toEqual([]);
    });
  });
});

// Buzz-purchased and code-redeemed memberships end without a cancelAt. Only those that lapse on or
// after NO_CANCEL_AT_REVOKE_FROM lose their cosmetics: stripping the older backlog was ruled out
// (2026-10-23). Before deleting the cutoff, read the comment on the constant.
describe('deliverMembershipCosmetics: memberships that end without a cancelAt', () => {
  const day = 24 * 60 * 60 * 1000;
  const at = (days: number) => new Date(NO_CANCEL_AT_REVOKE_FROM.getTime() + days * day);
  const ts = (d: Date) => d.toISOString();

  const BUZZ_LAPSED_BEFORE = 30;
  const BUZZ_LAPSED_AFTER = 31;
  const CODE_ENDED_AFTER = 32;
  const CODE_EXPIRED_CLAIMABLE = 33;
  const BUZZ_CURRENT = 34;
  const STRIPE_STALE_RENEWING = 35;
  const REFERRAL_HANDOVER = 38;
  const CANCELED_BEFORE_CUTOFF = 40;
  const SUPERSEDED_TO_CASH = 39;
  const STRIPE_ENDED_NO_CANCEL_AT = 37;

  const row = (
    id: string,
    userId: number,
    productId: string,
    status: string,
    end: Date,
    {
      cancelAtPeriodEnd = true,
      endedAt = null as Date | null,
      canceledAt = null as Date | null,
    } = {}
  ) =>
    `('${id}', ${userId}, '${productId}', '${status}', '${ts(
      new Date(end.getTime() - 30 * day)
    )}', '${ts(end)}', '2026-01-01', NULL, ${cancelAtPeriodEnd}, ${
      endedAt ? `'${ts(endedAt)}'` : 'NULL'
    }, ${canceledAt ? `'${ts(canceledAt)}'` : 'NULL'})`;

  beforeEach(async () => {
    await holder.db.exec(`
      INSERT INTO "CustomerSubscription" VALUES
        ${row('buzz-before', BUZZ_LAPSED_BEFORE, CIVITAI_BUZZ_BRONZE, 'canceled', at(-5), {
          endedAt: at(1),
        })},
        ${row('buzz-after', BUZZ_LAPSED_AFTER, CIVITAI_BUZZ_BRONZE, 'active', at(1))},
        ${row('redeemable-code-ended', CODE_ENDED_AFTER, CIVITAI_BRONZE, 'canceled', at(1), {
          endedAt: at(1),
          canceledAt: at(1),
        })},
        ${row('civ-canceled-early', CANCELED_BEFORE_CUTOFF, CIVITAI_BRONZE, 'canceled', at(1), {
          endedAt: at(-23),
          canceledAt: at(-23),
        })},
        ${row(
          's-ended-no-cancel-at',
          STRIPE_ENDED_NO_CANCEL_AT,
          BRONZE,
          'incomplete_expired',
          at(1),
          {
            cancelAtPeriodEnd: false,
            endedAt: at(1),
          }
        )},
        ${row(
          'redeemable-code-claimable',
          CODE_EXPIRED_CLAIMABLE,
          CIVITAI_BRONZE,
          'expired_claimable',
          at(1)
        )},
        ${row('buzz-current', BUZZ_CURRENT, CIVITAI_BUZZ_BRONZE, 'active', at(20))},
        ${row(
          'buzz-superseded-stale',
          STRIPE_STALE_RENEWING,
          CIVITAI_BUZZ_BRONZE,
          'canceled',
          at(1),
          {
            endedAt: at(-10),
          }
        )},
        ${row('s-stale-renewing', STRIPE_STALE_RENEWING, BRONZE, 'active', at(3.9), {
          cancelAtPeriodEnd: false,
        })},
        ${row('buzz-before-referral', REFERRAL_HANDOVER, CIVITAI_BUZZ_BRONZE, 'canceled', at(1))},
        ${row('civ-referral', REFERRAL_HANDOVER, CIVITAI_BRONZE, 'active', at(3.9), {
          cancelAtPeriodEnd: false,
        })},
        ${row('buzz-superseded', SUPERSEDED_TO_CASH, CIVITAI_BUZZ_BRONZE, 'canceled', at(1), {
          endedAt: at(-10),
        })},
        ${row('s-current', SUPERSEDED_TO_CASH, BRONZE, 'active', at(20), {
          cancelAtPeriodEnd: false,
        })};
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId") VALUES
        (${BUZZ_LAPSED_BEFORE}, ${CIVITAI_SEP_BRONZE}), (${BUZZ_LAPSED_BEFORE}, ${PERMANENT_BADGE}),
        (${BUZZ_LAPSED_AFTER}, ${CIVITAI_SEP_BRONZE}), (${BUZZ_LAPSED_AFTER}, ${PERMANENT_BADGE}),
        (${CODE_ENDED_AFTER}, ${CIVITAI_SEP_BRONZE}),
        (${CANCELED_BEFORE_CUTOFF}, ${CIVITAI_SEP_BRONZE}),
        (${CODE_EXPIRED_CLAIMABLE}, ${CIVITAI_SEP_BRONZE}),
        (${BUZZ_CURRENT}, ${CIVITAI_SEP_BRONZE}),
        (${STRIPE_STALE_RENEWING}, ${SEP_BRONZE}),
        (${REFERRAL_HANDOVER}, ${CIVITAI_SEP_BRONZE}),
        (${SUPERSEDED_TO_CASH}, ${SEP_BRONZE}),
        (${STRIPE_ENDED_NO_CANCEL_AT}, ${SEP_BRONZE});
    `);
  });

  // The job runs at 23:00.
  const runAfterCutoff = () => run(at(3 + 23 / 24), at(2 + 23 / 24));

  it('a Buzz membership that lapsed after the cutoff loses its non-permanent membership cosmetics', async () => {
    await runAfterCutoff();
    expect(await badgesOf(BUZZ_LAPSED_AFTER)).toEqual([PERMANENT_BADGE]);
  });

  // The backlog row was closed after the cutoff (tokens claimed late, or superseded), so its
  // endedAt is past the cutoff even though its period ended before it.
  it('a Buzz membership that lapsed before the cutoff keeps them (forward-only, no backlog revoke)', async () => {
    await runAfterCutoff();
    expect(await badgesOf(BUZZ_LAPSED_BEFORE)).toEqual([CIVITAI_SEP_BRONZE, PERMANENT_BADGE]);
  });

  it('a code membership ended by the prepaid job, or left expired_claimable, loses them', async () => {
    await runAfterCutoff();
    expect(await badgesOf(CODE_ENDED_AFTER)).toEqual([]);
    expect(await badgesOf(CODE_EXPIRED_CLAIMABLE)).toEqual([]);
  });

  it('a membership canceled before the cutoff keeps them when its unexpired period ends after it', async () => {
    await runAfterCutoff();
    expect(await badgesOf(CANCELED_BEFORE_CUTOFF)).toEqual([CIVITAI_SEP_BRONZE]);
  });

  it('a Buzz membership still inside its period keeps them', async () => {
    await runAfterCutoff();
    expect(await badgesOf(BUZZ_CURRENT)).toContain(CIVITAI_SEP_BRONZE);
  });

  it('a cash member with a superseded Buzz row keeps them while their renewal webhook is late', async () => {
    await runAfterCutoff();
    expect(await badgesOf(STRIPE_STALE_RENEWING)).toEqual([SEP_BRONZE]);
  });

  it('a referral member whose next chunk is not advanced yet keeps them past an old Buzz lapse', async () => {
    await runAfterCutoff();
    expect(await badgesOf(REFERRAL_HANDOVER)).toContain(CIVITAI_SEP_BRONZE);
  });

  it('the grace lasts a day: a membership still not renewed by the next run loses them', async () => {
    await runAfterCutoff();
    await run(at(4 + 23 / 24), at(3 + 23 / 24));
    expect(await badgesOf(REFERRAL_HANDOVER)).toEqual([]);
  });

  it('a manual rerun soon after the nightly run keeps the grace', async () => {
    await runAfterCutoff();
    await run(at(3 + 23.5 / 24), at(3 + 23 / 24));
    expect(await badgesOf(REFERRAL_HANDOVER)).toContain(CIVITAI_SEP_BRONZE);
  });

  it('a cash member with a superseded Buzz row keeps them', async () => {
    await runAfterCutoff();
    expect(await badgesOf(SUPERSEDED_TO_CASH)).toContain(SEP_BRONZE);
  });

  it('a cash subscription that ended without a cancelAt is unchanged: it keeps them', async () => {
    await runAfterCutoff();
    expect(await badgesOf(STRIPE_ENDED_NO_CANCEL_AT)).toEqual([SEP_BRONZE]);
  });
});

// A revoked cosmetic the user was wearing still shows in their search document until the users
// index re-pulls them, and the sync re-pulls an existing user only when their id is queued.
describe('deliverMembershipCosmetics: users search index', () => {
  it('queues the users who were wearing a revoked cosmetic, and only them', async () => {
    await holder.db.query(
      `UPDATE "UserCosmetic" SET "equippedAt" = now() WHERE "userId" = $1 AND "cosmeticId" = $2`,
      [LAPSED, NAMEPLATE]
    );
    await holder.db.query(
      `UPDATE "UserCosmetic" SET "equippedAt" = now(), "equippedToId" = 900 WHERE "userId" = $1`,
      [EXPIRED]
    );
    const { usersSearchIndex } = await import('~/server/search-index/users.search-index');
    const queue = vi.spyOn(usersSearchIndex, 'queueUpdate').mockResolvedValue();
    onTestFinished(() => queue.mockRestore());

    await run();

    expect(queue.mock.calls.flatMap(([items]) => items.map((x) => x.id))).toEqual([LAPSED]);
  });
});
