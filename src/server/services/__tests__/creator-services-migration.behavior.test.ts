import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The escrow's money invariants that live in the hand-applied migration rather than in
 * code, run against the real SQL on an in-process Postgres. The Prisma schema cannot
 * express the partial index or the CHECKs, so nothing else exercises them.
 */

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261025120000_creator_services_foundation/migration.sql'
);

const holder = { db: null as unknown as PGlite };
const q = async (sql: string, params?: unknown[]) => (await holder.db.query(sql, params)).rows;

const SELLER = 1;
const BUYER = 2;

async function insertDeal(overrides: Record<string, unknown> = {}) {
  const row = {
    offeringId: 1,
    buyerId: BUYER,
    sellerId: SELLER,
    price: 1000,
    buzzType: 'yellow',
    feeAmount: 0,
    status: 'Requested',
    releaseAt: null,
    ...overrides,
  };
  const [deal] = await q(
    `INSERT INTO "ServiceDeal" ("offeringId", "buyerId", "sellerId", price, "buzzType", "feeAmount",
       "revisionsIncluded", "deliveryDays", "previewKind", status, "requestText", "releaseAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 1, 3, 'Image', $7, 'a request', $8, now())
     RETURNING id`,
    [
      row.offeringId,
      row.buyerId,
      row.sellerId,
      row.price,
      row.buzzType,
      row.feeAmount,
      row.status,
      row.releaseAt,
    ]
  );
  return (deal as { id: number }).id;
}

async function insertLeg(
  dealId: number,
  leg: string,
  externalTransactionId = `svc:${dealId}:${leg}`
) {
  await q(
    `INSERT INTO "ServiceDealTransaction" ("dealId", leg, "externalTransactionId", amount, "buzzType")
     VALUES ($1, $2, $3, 1000, 'yellow')`,
    [dealId, leg, externalTransactionId]
  );
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`CREATE TABLE "User" (id int PRIMARY KEY)`);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFile", "ServiceDeal", "ServiceOffering" RESTART IDENTITY;
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "updatedAt")
      VALUES (${SELLER}, 'Offering', 'desc', 1000, 3, now());
  `);
});

describe('creator services migration', () => {
  it('re-applies cleanly, because it is applied by hand and may run twice', async () => {
    await expect(holder.db.exec(readFileSync(MIGRATION, 'utf8'))).resolves.toBeDefined();
  });

  describe('a deal can never take both the release and the refund leg', () => {
    it('refuses a refund after a release', async () => {
      const dealId = await insertDeal();
      await insertLeg(dealId, 'Hold');
      await insertLeg(dealId, 'Release');
      await expect(insertLeg(dealId, 'Refund')).rejects.toThrow(
        /ServiceDealTransaction_dealId_payout_key/
      );
    });

    it('refuses a release after a refund', async () => {
      const dealId = await insertDeal();
      await insertLeg(dealId, 'Hold');
      await insertLeg(dealId, 'Refund');
      await expect(insertLeg(dealId, 'Release')).rejects.toThrow(
        /ServiceDealTransaction_dealId_payout_key/
      );
    });

    it('still lets a release carry its fee leg, and other deals pay independently', async () => {
      const dealId = await insertDeal();
      const other = await insertDeal();
      await insertLeg(dealId, 'Hold');
      await insertLeg(dealId, 'Release');
      await insertLeg(dealId, 'Fee');
      await insertLeg(other, 'Refund');
      const rows = await q(`SELECT count(*)::int AS n FROM "ServiceDealTransaction"`);
      expect(rows).toEqual([{ n: 4 }]);
    });
  });

  it('refuses the same leg twice and a reused external transaction id', async () => {
    const dealId = await insertDeal();
    const other = await insertDeal();
    await insertLeg(dealId, 'Hold');
    await expect(insertLeg(dealId, 'Hold', 'svc:fresh-id')).rejects.toThrow(
      /ServiceDealTransaction_dealId_leg_key/
    );
    await expect(insertLeg(other, 'Hold', `svc:${dealId}:Hold`)).rejects.toThrow(
      /ServiceDealTransaction_externalTransactionId_key/
    );
  });

  it('refuses a Completed deal without releaseAt, which the release sweeper would never pay', async () => {
    await expect(insertDeal({ status: 'Completed' })).rejects.toThrow(
      /ServiceDeal_completed_has_releaseAt/
    );
    await expect(insertDeal({ status: 'Completed', releaseAt: new Date() })).resolves.toEqual(
      expect.any(Number)
    );
  });

  it('refuses a fee that reaches the price', async () => {
    await expect(insertDeal({ feeAmount: 1000 })).rejects.toThrow(/ServiceDeal_fee_below_price/);
    await expect(insertDeal({ feeAmount: 999 })).resolves.toEqual(expect.any(Number));
  });

  it('refuses a deal with yourself', async () => {
    await expect(insertDeal({ buyerId: SELLER })).rejects.toThrow(/ServiceDeal_buyer_not_seller/);
  });

  it('keeps the money record when someone tries to delete a party to it', async () => {
    await insertDeal();
    await expect(q(`DELETE FROM "User" WHERE id = $1`, [BUYER])).rejects.toThrow(
      /ServiceDeal_buyerId_fkey/
    );
  });
});
