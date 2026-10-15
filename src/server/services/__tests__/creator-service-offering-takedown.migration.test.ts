import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The moderator-takedown migration run against the real SQL on an in-process Postgres: the CHECK
 * that ties a recorded removal to a Removed offering, the report join table, and re-application.
 */

const migration = (name: string) =>
  readFileSync(
    join(process.cwd(), `packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`),
    'utf8'
  );
const FOUNDATION = migration('20261025120000_creator_services_foundation');
const TAKEDOWN = migration('20261028170000_creator_service_offering_takedown');

const holder = { db: null as unknown as PGlite };
const q = async (sql: string, params?: unknown[]) => (await holder.db.query(sql, params)).rows;

const SELLER = 1;
const MOD = 2;

const setRemoval = (
  status: string,
  removedReason: string | null,
  removedAt: Date | null,
  by: number | null
) =>
  q(
    `UPDATE "ServiceOffering"
       SET status = $1::"ServiceOfferingStatus", "removedReason" = $2, "removedAt" = $3, "removedById" = $4
     WHERE id = 1`,
    [status, removedReason, removedAt, by]
  );

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`CREATE TABLE "User" (id int PRIMARY KEY)`);
  await holder.db.exec(`CREATE TABLE "Report" (id serial PRIMARY KEY)`);
  await holder.db.exec(FOUNDATION);
  await holder.db.exec(TAKEDOWN);
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "ServiceOfferingReport", "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFile", "ServiceDeal", "ServiceOffering", "Report" RESTART IDENTITY;
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${MOD});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "updatedAt", status)
      VALUES (${SELLER}, 'Offering', 'desc', 1000, 3, now(), 'Active');
  `);
});

describe('offering takedown migration', () => {
  it('re-applies cleanly over live rows, because it is applied by hand and may run twice', async () => {
    await setRemoval('Removed', 'spam', new Date(), MOD);
    await expect(holder.db.exec(TAKEDOWN)).resolves.toBeDefined();
    expect(await q(`SELECT "removedReason" FROM "ServiceOffering" WHERE id = 1`)).toEqual([
      { removedReason: 'spam' },
    ]);
  });

  it("leaves a seller's own remove with no removal record", async () => {
    await expect(setRemoval('Removed', null, null, null)).resolves.toBeDefined();
  });

  it('accepts a moderator removal with its time and moderator', async () => {
    await expect(setRemoval('Removed', 'spam', new Date(), MOD)).resolves.toBeDefined();
  });

  it.each([
    ['on an offering that is not Removed', 'Active', new Date(), MOD],
    ['without a time', 'Removed', null, MOD],
    ['without a moderator', 'Removed', new Date(), null],
  ])('refuses a recorded removal %s', async (_, status, at, by) => {
    await expect(
      setRemoval(status as string, 'spam', at as Date | null, by as number | null)
    ).rejects.toThrow(/ServiceOffering_removed_by_moderator/);
  });

  it('files one report per join row and drops it with the report', async () => {
    await q(`INSERT INTO "Report" DEFAULT VALUES`);
    await q(`INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, 1)`);
    await expect(
      q(`INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, 1)`)
    ).rejects.toThrow(/ServiceOfferingReport_pkey|ServiceOfferingReport_reportId_key/);
    await q(`INSERT INTO "Report" DEFAULT VALUES`);
    await expect(
      q(`INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (99, 2)`)
    ).rejects.toThrow(/ServiceOfferingReport_serviceOfferingId_fkey/);
    await q(`DELETE FROM "Report" WHERE id = 1`);
    expect(await q(`SELECT count(*)::int AS n FROM "ServiceOfferingReport"`)).toEqual([{ n: 0 }]);
  });

  it('attaches a report to one offering only', async () => {
    await q(`INSERT INTO "Report" DEFAULT VALUES`);
    await q(
      `INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "updatedAt")
       VALUES (${SELLER}, 'Second', 'desc', 1000, 3, now())`
    );
    await q(`INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, 1)`);
    await expect(
      q(`INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (2, 1)`)
    ).rejects.toThrow(/ServiceOfferingReport_reportId_key/);
  });

  it('drops the join row with the offering', async () => {
    await q(`INSERT INTO "Report" DEFAULT VALUES`);
    await q(`INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, 1)`);
    await q(`DELETE FROM "ServiceOffering" WHERE id = 1`);
    expect(await q(`SELECT count(*)::int AS n FROM "ServiceOfferingReport"`)).toEqual([{ n: 0 }]);
  });
});
