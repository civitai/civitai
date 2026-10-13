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
const OLD_PROVIDER_SILVER = 'old-provider-silver';

// Badge ids: <month><tier>. Windows mirror how monthly badges are authored (start and end at 07:00).
const SEP_BRONZE = 91;
const SEP_SILVER = 92;
const OCT_BRONZE = 101;
const OCT_SILVER = 102;
const PERMANENT_BADGE = 200;
const UNDATED_PRODUCT_COSMETIC = 300; // carries a productId but no window, so it is not a monthly badge

const ONTIME = 1; // Silver, renewed mid-October
const LATE = 2; // Bronze, period started Sep 28, invoice paid Oct 8
const RETURNING = 3; // active Bronze now, plus an old canceled subscription from another provider
const LAPSED = 4; // canceled before its period ran out, nothing active
const UNRENEWED = 5; // Bronze, period started Sep 20 and still running
const EXPIRED = 6; // row still says active, but its period ended and it was set to cancel

// The run under test: the nightly job on Oct 8, its previous run the night before.
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
      UNIQUE ("userId", "cosmeticId", "claimKey")
    );
    INSERT INTO "Product" VALUES
      ('${BRONZE}', 'Stripe', true, '{"level": 1, "tier": "bronze"}'),
      ('${SILVER}', 'Stripe', true, '{"level": 2, "tier": "silver"}'),
      ('${OLD_PROVIDER_SILVER}', 'Paddle', true, '{"level": 2, "tier": "silver"}');
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
      (${PERMANENT_BADGE}, 'Keepsake', 'Membership', true, NULL, NULL, NULL),
      (${UNDATED_PRODUCT_COSMETIC}, 'Nameplate', 'Membership', true, '${BRONZE}', NULL, NULL);
    INSERT INTO "CustomerSubscription" VALUES
      ${sub('s-ontime', ONTIME, SILVER, 'active', '2026-10-05 10:00', '2026-11-05 10:00')},
      ${sub('s-late', LATE, BRONZE, 'active', '2026-09-28 12:00', '2026-10-28 12:00')},
      ${sub('s-returning', RETURNING, BRONZE, 'active', '2026-10-03 09:00', '2026-11-03 09:00')},
      ${sub(
        's-returning-old',
        RETURNING,
        OLD_PROVIDER_SILVER,
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
      )};
    INSERT INTO "UserCosmetic" ("userId", "cosmeticId") VALUES
      (${RETURNING}, ${OCT_BRONZE}),
      (${LAPSED}, ${SEP_BRONZE}),
      (${LAPSED}, ${PERMANENT_BADGE}),
      (${UNRENEWED}, ${SEP_BRONZE}),
      (${EXPIRED}, ${SEP_BRONZE});
  `);
});

const badgesOf = async (userId: number) =>
  (
    await holder.db.query<{ cosmeticId: number }>(
      `SELECT "cosmeticId" FROM "UserCosmetic" WHERE "userId" = $1 ORDER BY "cosmeticId"`,
      [userId]
    )
  ).rows.map((r) => r.cosmeticId);

const run = () => deliverMembershipCosmetics({ now: NOW, lastDelivered: LAST_DELIVERED });

describe('deliverMembershipCosmetics', () => {
  it("grants the month of the current period, for the member's tier and every tier below it", async () => {
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

  it('keeps the badges of an active member who also has an old canceled subscription', async () => {
    await run();
    expect(await badgesOf(RETURNING)).toEqual([OCT_BRONZE]);
  });

  it('still revokes non-permanent membership badges from a member with nothing active', async () => {
    await run();
    expect(await badgesOf(LAPSED)).toEqual([PERMANENT_BADGE]);
  });

  it('revokes from a member whose only "active" row has a period that already ended', async () => {
    await run();
    expect(await badgesOf(EXPIRED)).toEqual([]);
  });

  it('is idempotent across nightly runs', async () => {
    await run();
    await run();
    expect(await badgesOf(ONTIME)).toEqual([OCT_BRONZE, OCT_SILVER]);
    expect(await badgesOf(LATE)).toEqual([SEP_BRONZE]);
  });
});
