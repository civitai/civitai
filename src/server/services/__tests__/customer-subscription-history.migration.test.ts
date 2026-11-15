import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The CustomerSubscriptionHistory trigger and reconcile function, run from the real migration
 * against a real Postgres. Everything the billing page shows as past memberships comes from here.
 */

const MIGRATION = resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261122120000_customer_subscription_history/migration.sql'
);

let pg: PGlite;

const insertSub = (
  id: string,
  userId: number,
  buzzType: string,
  { status = 'active', productId = 'prod_gold', start = '2026-01-01', end = '2026-02-01' } = {}
) =>
  pg.query(
    `INSERT INTO "CustomerSubscription" VALUES ($1, $2, '{}', $3, 'price', $4, false, NULL, NULL, $5, $6, $5, NULL, NULL, $7)`,
    [id, userId, status, productId, start, end, buzzType]
  );

type HistoryRow = {
  subscriptionId: string;
  productId: string;
  status: string;
  closedReason: string | null;
  open: boolean;
};

const historyFor = async (userId: number) =>
  (
    await pg.query<HistoryRow>(
      `SELECT "subscriptionId", "productId", status, "closedReason", "closedAt" IS NULL AS open
       FROM "CustomerSubscriptionHistory" WHERE "userId" = $1 ORDER BY id`,
      [userId]
    )
  ).rows;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "CustomerSubscription" (
      "id" TEXT PRIMARY KEY, "userId" INTEGER NOT NULL, "metadata" JSONB NOT NULL,
      "status" TEXT NOT NULL, "priceId" TEXT NOT NULL, "productId" TEXT NOT NULL,
      "cancelAtPeriodEnd" BOOLEAN NOT NULL, "cancelAt" TIMESTAMP(3), "canceledAt" TIMESTAMP(3),
      "currentPeriodStart" TIMESTAMP(3) NOT NULL, "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL, "endedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3),
      "buzzType" TEXT NOT NULL DEFAULT 'yellow', UNIQUE ("userId", "buzzType")
    );
  `);
  // A subscription that exists before the migration, to be backfilled.
  await insertSub('pre-existing', 1, 'yellow', { status: 'canceled' });
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
});

describe('CustomerSubscriptionHistory', () => {
  it('backfills an open row for every subscription that already existed', async () => {
    expect(await historyFor(1)).toEqual([
      {
        subscriptionId: 'pre-existing',
        productId: 'prod_gold',
        status: 'canceled',
        closedReason: null,
        open: true,
      },
    ]);
  });

  it('keeps a renewal as one membership, and splits replacements, plan changes and deletes', async () => {
    await insertSub('sub_a', 2, 'green');
    // Contiguous renewal: same membership.
    await pg.exec(
      `UPDATE "CustomerSubscription" SET "currentPeriodStart" = '2026-02-01', "currentPeriodEnd" = '2026-03-01' WHERE id = 'sub_a'`
    );
    // A new Stripe subscription overwrites the id in place.
    await pg.exec(
      `UPDATE "CustomerSubscription" SET id = 'sub_b', "createdAt" = '2026-03-01' WHERE id = 'sub_a'`
    );
    await pg.exec(
      `UPDATE "CustomerSubscription" SET "productId" = 'prod_silver' WHERE id = 'sub_b'`
    );
    await pg.exec(`DELETE FROM "CustomerSubscription" WHERE id = 'sub_b'`);

    expect(await historyFor(2)).toEqual([
      expect.objectContaining({ subscriptionId: 'sub_a', closedReason: 'replaced', open: false }),
      expect.objectContaining({
        subscriptionId: 'sub_b',
        productId: 'prod_gold',
        closedReason: 'plan-changed',
      }),
      expect.objectContaining({
        subscriptionId: 'sub_b',
        productId: 'prod_silver',
        status: 'canceled',
        closedReason: 'removed',
        open: false,
      }),
    ]);
  });

  it('records a repeat Buzz purchase on the same row as a new membership', async () => {
    await insertSub('buzz-tx', 3, 'buzzPurchase');
    await pg.exec(
      `UPDATE "CustomerSubscription" SET "currentPeriodStart" = '2026-05-01', "currentPeriodEnd" = '2026-06-01' WHERE id = 'buzz-tx'`
    );

    expect(await historyFor(3)).toEqual([
      expect.objectContaining({ closedReason: 'restarted', open: false }),
      expect.objectContaining({ closedReason: null, open: true }),
    ]);
  });

  it('never blocks the billing write when the history write fails', async () => {
    await insertSub('sub_fail', 4, 'yellow');
    await pg.exec(
      `ALTER TABLE "CustomerSubscriptionHistory" ADD CONSTRAINT fail_past_due CHECK (status <> 'past_due')`
    );
    await pg.exec(`UPDATE "CustomerSubscription" SET status = 'past_due' WHERE id = 'sub_fail'`);
    await pg.exec(`ALTER TABLE "CustomerSubscriptionHistory" DROP CONSTRAINT fail_past_due`);

    const live = await pg.query<{ status: string }>(
      `SELECT status FROM "CustomerSubscription" WHERE id = 'sub_fail'`
    );
    expect(live.rows[0].status).toBe('past_due');
    expect((await historyFor(4))[0].status).toBe('active');
  });

  it('reconciles writes the trigger missed, and is a no-op once in sync', async () => {
    await pg.exec(
      `ALTER TABLE "CustomerSubscription" DISABLE TRIGGER customer_subscription_history_sync`
    );
    await pg.exec(`DELETE FROM "CustomerSubscription" WHERE id = 'buzz-tx'`);
    await insertSub('sub_new', 5, 'green');
    await pg.exec(
      `ALTER TABLE "CustomerSubscription" ENABLE TRIGGER customer_subscription_history_sync`
    );

    const reconcile = async () =>
      (
        await pg.query<{ refreshed: number; closed: number }>(
          `SELECT refreshed, closed FROM customer_subscription_history_reconcile()`
        )
      ).rows[0];

    // sub_fail's past_due drift (from the failed write above) and sub_new; buzz-tx is gone.
    expect(await reconcile()).toEqual({ refreshed: 2, closed: 1 });
    expect(await reconcile()).toEqual({ refreshed: 0, closed: 0 });
    expect((await historyFor(3)).at(-1)).toMatchObject({ closedReason: 'removed', open: false });
    expect((await historyFor(4))[0].status).toBe('past_due');
    expect(await historyFor(5)).toEqual([
      expect.objectContaining({ subscriptionId: 'sub_new', open: true }),
    ]);
  });
});
