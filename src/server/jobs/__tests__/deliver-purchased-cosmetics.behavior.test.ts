import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const { deliverMembershipCosmetics } = await import('~/server/jobs/deliver-purchased-cosmetics');

const BRONZE = 'stripe-bronze';
const SILVER = 'stripe-silver';
const OTHER_PROVIDER_BRONZE = 'other-provider-bronze';
const OTHER_PROVIDER_SILVER = 'other-provider-silver';
const CIVITAI_BRONZE = 'civitai-bronze';
const FOUNDER = 'founder';

const SEP_BRONZE = 91;
const SEP_SILVER = 92;
const OCT_BRONZE = 101;
const OCT_SILVER = 102;
const OTHER_PROVIDER_OCT_BRONZE = 103;
const CIVITAI_SEP_BRONZE = 94;
const CIVITAI_OCT_BRONZE = 104;
const PERMANENT_BADGE = 200;
const NON_MEMBERSHIP_ITEM = 201; // not permanent, but not a Membership cosmetic either
const UNDATED_PRODUCT_COSMETIC = 300; // carries a productId but no window, so it is not a monthly badge
const GRANDFATHER = 400;

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
      "cancelAt" timestamp(3)
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
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    INSERT INTO "Product" VALUES
      ('${BRONZE}', 'Stripe', true, '{"level": 1, "tier": "bronze"}'),
      ('${SILVER}', 'Stripe', true, '{"level": 2, "tier": "silver"}'),
      ('${OTHER_PROVIDER_BRONZE}', 'Paddle', true, '{"level": 1, "tier": "bronze"}'),
      ('${OTHER_PROVIDER_SILVER}', 'Paddle', true, '{"level": 2, "tier": "silver"}'),
      ('${CIVITAI_BRONZE}', 'Civitai', true, '{"level": 1, "tier": "bronze"}'),
      ('${FOUNDER}', 'Stripe', false, '{"tier": "founder"}');
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
      (${UNDATED_PRODUCT_COSMETIC}, 'Nameplate', 'Membership', true, '${BRONZE}', NULL, NULL),
      (${GRANDFATHER}, 'Grandfather Badge', 'Membership', true, NULL, NULL, NULL);
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
      )};
    INSERT INTO "UserCosmetic" ("userId", "cosmeticId") VALUES
      (${RETURNING}, ${OCT_BRONZE}),
      (${LAPSED}, ${SEP_BRONZE}),
      (${LAPSED}, ${PERMANENT_BADGE}),
      (${LAPSED}, ${NON_MEMBERSHIP_ITEM}),
      (${UNRENEWED}, ${SEP_BRONZE}),
      (${EXPIRED}, ${SEP_BRONZE}),
      (${TRIALING}, ${SEP_BRONZE}),
      (${CANCELING}, ${SEP_BRONZE});
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
    it("grants the month of the current period, for the member's tier and every lower tier of the same provider", async () => {
      await run();
      expect(await badgesOf(ONTIME)).toEqual([OCT_BRONZE, OCT_SILVER]);
    });

    it('grants the badge for the month a period started in, when payment lands in the next month', async () => {
      await run();
      expect(await badgesOf(LATE)).toEqual([SEP_BRONZE]);
    });

    it('does not grant a month the current period did not start in', async () => {
      await run();
      expect(await badgesOf(UNRENEWED)).toEqual([SEP_BRONZE]);
    });

    it('counts a period starting on the first before the badge opens as that month', async () => {
      await run();
      expect(await badgesOf(FIRST_OF_MONTH)).toEqual([OCT_BRONZE]);
    });

    it('counts a period starting on the last day after the badge closes as that month', async () => {
      await run();
      expect(await badgesOf(LAST_OF_MONTH)).toEqual([SEP_BRONZE]);
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
    });

    it('is idempotent, including on the following night', async () => {
      await run();
      const after = (await holder.db.query(`SELECT 1 FROM "UserCosmetic"`)).rows.length;
      await run();
      expect((await holder.db.query(`SELECT 1 FROM "UserCosmetic"`)).rows.length).toBe(after);

      await run(new Date('2026-10-09T23:00:00Z'), NOW);
      expect(await badgesOf(ONTIME)).toEqual([OCT_BRONZE, OCT_SILVER]);
      expect(await badgesOf(LATE)).toEqual([SEP_BRONZE]);
    });
  });

  describe('revoke', () => {
    it('keeps the badges of an active member who also has an old canceled subscription', async () => {
      await run();
      expect(await badgesOf(RETURNING)).toEqual([OCT_BRONZE]);
    });

    it('keeps the badges of a trialing member who also has an old canceled subscription', async () => {
      await run();
      expect(await badgesOf(TRIALING)).toEqual([SEP_BRONZE]);
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
