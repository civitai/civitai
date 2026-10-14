import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The escrow's money invariants that live in the hand-applied migration rather than in
 * code, run against the real SQL on an in-process Postgres. The Prisma schema cannot
 * express the partial indexes, the composite FK or the CHECKs, so nothing else exercises them.
 */

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261025120000_creator_services_foundation/migration.sql'
);

const holder = { db: null as unknown as PGlite };
const q = async (sql: string, params?: unknown[]) => (await holder.db.query(sql, params)).rows;

const SELLER = 1;
const BUYER = 2;
const OTHER_SELLER = 3;
const OFFERING = 1;
const OTHER_OFFERING = 2;

async function insertDeal(overrides: Record<string, unknown> = {}) {
  const row = {
    offeringId: OFFERING,
    buyerId: BUYER,
    sellerId: SELLER,
    price: 1000,
    buzzType: 'yellow',
    feeAmount: 0,
    status: 'Requested',
    heldAt: null,
    settledAt: null,
    releaseAt: null,
    disputeResolvedAt: null,
    disputeResolution: null,
    ...overrides,
  };
  const [deal] = await q(
    `INSERT INTO "ServiceDeal" ("offeringId", "buyerId", "sellerId", price, "buzzType", "feeAmount",
       "revisionsIncluded", "deliveryDays", "previewKind", status, "requestText", "heldAt",
       "settledAt", "releaseAt", "disputeResolvedAt", "disputeResolution", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 1, 3, 'Image', $7, 'a request', $8, $9, $10, $11, $12, now())
     RETURNING id`,
    [
      row.offeringId,
      row.buyerId,
      row.sellerId,
      row.price,
      row.buzzType,
      row.feeAmount,
      row.status,
      row.heldAt,
      row.settledAt,
      row.releaseAt,
      row.disputeResolvedAt,
      row.disputeResolution,
    ]
  );
  return (deal as { id: number }).id;
}

async function insertLeg(
  dealId: number,
  leg: string,
  { externalTransactionId = `svc:${dealId}:${leg}`, amount = 1000 } = {}
) {
  await q(
    `INSERT INTO "ServiceDealTransaction" ("dealId", leg, "externalTransactionId", amount, "buzzType")
     VALUES ($1, $2, $3, $4, 'yellow')`,
    [dealId, leg, externalTransactionId, amount]
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
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER}), (${OTHER_SELLER});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "updatedAt")
      VALUES (${SELLER}, 'Offering', 'desc', 1000, 3, now()),
             (${OTHER_SELLER}, 'Other', 'desc', 1000, 3, now());
  `);
});

describe('creator services migration', () => {
  it('re-applies cleanly over live rows, because it is applied by hand and may run twice', async () => {
    const dealId = await insertDeal({ status: 'Accepted', heldAt: new Date() });
    await insertLeg(dealId, 'Hold');
    await expect(holder.db.exec(readFileSync(MIGRATION, 'utf8'))).resolves.toBeDefined();
    expect(await q(`SELECT count(*)::int AS n FROM "ServiceDealTransaction"`)).toEqual([{ n: 1 }]);
  });

  describe('a refunded deal can take neither half of a payout', () => {
    it.each([
      ['Release', 'Refund', 'ServiceDealTransaction_dealId_payout_key'],
      ['Refund', 'Release', 'ServiceDealTransaction_dealId_payout_key'],
      ['Fee', 'Refund', 'ServiceDealTransaction_dealId_fee_refund_key'],
      ['Refund', 'Fee', 'ServiceDealTransaction_dealId_fee_refund_key'],
    ])('refuses %s then %s', async (first, second, constraint) => {
      const dealId = await insertDeal();
      await insertLeg(dealId, 'Hold');
      await insertLeg(dealId, first);
      await expect(insertLeg(dealId, second)).rejects.toThrow(new RegExp(constraint));
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
    await expect(
      insertLeg(dealId, 'Hold', { externalTransactionId: 'svc:fresh-id' })
    ).rejects.toThrow(/ServiceDealTransaction_dealId_leg_key/);
    await expect(
      insertLeg(other, 'Hold', { externalTransactionId: `svc:${dealId}:Hold` })
    ).rejects.toThrow(/ServiceDealTransaction_externalTransactionId_key/);
  });

  it('refuses a leg that moves no Buzz', async () => {
    const dealId = await insertDeal();
    await expect(insertLeg(dealId, 'Hold', { amount: 0 })).rejects.toThrow(
      /ServiceDealTransaction_amount_check/
    );
  });

  describe('a deal nobody paid for can never be worked or paid out', () => {
    // `releaseAt` is set throughout so a Completed deal can only trip the held check.
    it.each([
      'Accepted',
      'Delivered',
      'InRevision',
      'Completed',
      'CancellationRequested',
      'Disputed',
    ])('refuses %s without heldAt', async (status) => {
      const releaseAt = new Date();
      await expect(insertDeal({ status, releaseAt })).rejects.toThrow(
        /ServiceDeal_held_before_work/
      );
      await expect(insertDeal({ status, releaseAt, heldAt: new Date() })).resolves.toEqual(
        expect.any(Number)
      );
    });

    it('refuses a settled deal that was never held', async () => {
      await expect(insertDeal({ status: 'Declined', settledAt: new Date() })).rejects.toThrow(
        /ServiceDeal_settled_after_held/
      );
    });

    it('lets an unpaid request close without a hold', async () => {
      for (const status of ['Declined', 'Expired', 'Cancelled'])
        await expect(insertDeal({ status })).resolves.toEqual(expect.any(Number));
    });
  });

  it('refuses a Completed deal without releaseAt, which the release sweeper would never pay', async () => {
    const held = { status: 'Completed', heldAt: new Date() };
    await expect(insertDeal(held)).rejects.toThrow(/ServiceDeal_completed_has_releaseAt/);
    await expect(insertDeal({ ...held, releaseAt: new Date() })).resolves.toEqual(
      expect.any(Number)
    );
  });

  it.each([
    [1000, 'reaches the price'],
    [-1, 'is negative and would pay the seller more than the price'],
  ])('refuses a fee of %i, which %s', async (feeAmount) => {
    await expect(insertDeal({ feeAmount })).rejects.toThrow(/ServiceDeal_fee_below_price/);
  });

  it('accepts a fee just below the price', async () => {
    await expect(insertDeal({ feeAmount: 999 })).resolves.toEqual(expect.any(Number));
  });

  it('refuses a free deal, through the fee check', async () => {
    await expect(insertDeal({ price: 0 })).rejects.toThrow(/ServiceDeal_fee_below_price/);
  });

  it('refuses a free offering', async () => {
    await expect(
      q(
        `INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "updatedAt")
         VALUES ($1, 'Free', 'desc', 0, 3, now())`,
        [SELLER]
      )
    ).rejects.toThrow(/ServiceOffering_price_check/);
  });

  it('refuses a leg in a different Buzz type from its deal', async () => {
    const dealId = await insertDeal({ buzzType: 'green' });
    await expect(insertLeg(dealId, 'Hold')).rejects.toThrow(
      /ServiceDealTransaction_deal_buzzType_fkey/
    );
  });

  it('refuses moving an offering that has a deal to another seller, since the payout would follow', async () => {
    await insertDeal({ status: 'Accepted', heldAt: new Date() });
    await expect(
      q(`UPDATE "ServiceOffering" SET "sellerId" = $1 WHERE id = $2`, [OTHER_SELLER, OFFERING])
    ).rejects.toThrow(/ServiceDeal_offering_seller_fkey/);
    expect(await q(`SELECT "sellerId" FROM "ServiceDeal"`)).toEqual([{ sellerId: SELLER }]);
  });

  it('refuses a deal with yourself', async () => {
    await expect(insertDeal({ buyerId: SELLER, sellerId: SELLER })).rejects.toThrow(
      /ServiceDeal_buyer_not_seller/
    );
  });

  it("refuses a seller who does not own the offering, since release pays the deal's seller", async () => {
    await expect(insertDeal({ sellerId: OTHER_SELLER })).rejects.toThrow(
      /ServiceDeal_offering_seller_fkey/
    );
    await expect(
      insertDeal({ offeringId: OTHER_OFFERING, sellerId: OTHER_SELLER })
    ).resolves.toEqual(expect.any(Number));
  });

  it('refuses a dispute marked resolved without a resolution, and the reverse', async () => {
    const held = { status: 'Disputed', heldAt: new Date() };
    await expect(insertDeal({ ...held, disputeResolvedAt: new Date() })).rejects.toThrow(
      /ServiceDeal_dispute_resolution_consistent/
    );
    await expect(insertDeal({ ...held, disputeResolution: 'Refund' })).rejects.toThrow(
      /ServiceDeal_dispute_resolution_consistent/
    );
  });

  describe('keeps the money record when something it hangs off is deleted', () => {
    it.each([
      ['the buyer', `DELETE FROM "User" WHERE id = ${BUYER}`, 'ServiceDeal_buyerId_fkey'],
      [
        'the offering',
        `DELETE FROM "ServiceOffering" WHERE id = ${OFFERING}`,
        'ServiceDeal_offeringId_fkey|ServiceDeal_offering_seller_fkey',
      ],
      [
        'the deal, via its receipt',
        `DELETE FROM "ServiceDeal"`,
        'ServiceDealTransaction_dealId_fkey',
      ],
    ])('refuses deleting %s', async (_name, sql, constraint) => {
      const dealId = await insertDeal();
      await insertLeg(dealId, 'Hold');
      await expect(q(sql)).rejects.toThrow(new RegExp(constraint));
    });

    it('refuses deleting the seller, whose offering cascades but whose deals do not', async () => {
      await insertDeal();
      // Any of the deal's three FKs may be the one that refuses; which is a planner detail.
      await expect(q(`DELETE FROM "User" WHERE id = ${SELLER}`)).rejects.toThrow(
        /ServiceDeal_sellerId_fkey|ServiceDeal_offeringId_fkey|ServiceDeal_offering_seller_fkey/
      );
    });

    // The behavioural cases above cannot tell which FK refused: the offering's FKs mask the
    // seller's. So the delete and update action of every money FK is read from the catalog.
    it('declares every money FK RESTRICT on delete, and no deal FK cascades an update of the payee', async () => {
      const rows = await q(
        `SELECT conname, confdeltype, confupdtype FROM pg_constraint
         WHERE contype = 'f' AND conrelid::regclass::text IN
           ('"ServiceDeal"', '"ServiceDealEvent"', '"ServiceDealFile"', '"ServiceDealTransaction"')
         ORDER BY conname`
      );
      // r = RESTRICT, a = NO ACTION, c = CASCADE
      expect(rows).toEqual([
        { conname: 'ServiceDealEvent_dealId_fkey', confdeltype: 'r', confupdtype: 'c' },
        { conname: 'ServiceDealFile_dealId_fkey', confdeltype: 'r', confupdtype: 'c' },
        { conname: 'ServiceDealTransaction_dealId_fkey', confdeltype: 'r', confupdtype: 'c' },
        {
          conname: 'ServiceDealTransaction_deal_buzzType_fkey',
          confdeltype: 'r',
          confupdtype: 'a',
        },
        { conname: 'ServiceDeal_buyerId_fkey', confdeltype: 'r', confupdtype: 'c' },
        { conname: 'ServiceDeal_offeringId_fkey', confdeltype: 'r', confupdtype: 'c' },
        { conname: 'ServiceDeal_offering_seller_fkey', confdeltype: 'r', confupdtype: 'a' },
        { conname: 'ServiceDeal_sellerId_fkey', confdeltype: 'r', confupdtype: 'c' },
      ]);
    });

    it.each([
      [
        'ServiceDealEvent',
        `INSERT INTO "ServiceDealEvent" ("dealId", "actorId", type) VALUES ($1, -1, 'Requested')`,
      ],
      [
        'ServiceDealFile',
        `INSERT INTO "ServiceDealFile" ("dealId", kind, "s3Key", "mimeType", size) VALUES ($1, 'Preview', 'k', 'image/png', 1)`,
      ],
    ])('refuses deleting a deal that has a %s row', async (table, insert) => {
      const dealId = await insertDeal();
      await q(insert, [dealId]);
      await expect(q(`DELETE FROM "ServiceDeal"`)).rejects.toThrow(
        new RegExp(`${table}_dealId_fkey`)
      );
    });
  });
});
