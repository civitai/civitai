import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import type * as UsersService from '../users.service';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ query: async () => ({ json: async () => [] }) }),
}));
vi.mock('../users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UsersService>()),
  usersByIds: async () => new Map(),
}));

const { getShopPurchaseSummary } = await import('../shop-purchases.service');

const SCHEMA = `
CREATE TABLE "Cosmetic" ("id" INTEGER PRIMARY KEY, "type" TEXT NOT NULL);
CREATE TABLE "CosmeticShopItem" ("id" INTEGER PRIMARY KEY, "title" TEXT NOT NULL);
CREATE TABLE "UserCosmeticShopPurchases" (
  "buzzTransactionId" TEXT PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "cosmeticId" INTEGER,
  "shopItemId" INTEGER NOT NULL REFERENCES "CosmeticShopItem"("id"),
  "unitAmount" INTEGER NOT NULL DEFAULT 100,
  "purchasedAt" TIMESTAMP(3) NOT NULL,
  "refunded" BOOLEAN NOT NULL DEFAULT FALSE
);
`;

const BUYER = 5;
const OTHER_BUYER = 6;
const ROW_CAP = 1000;

let db: PGlite;

const seedItems = (...ids: number[]) =>
  Promise.all(
    ids.map((id) =>
      db.query(`INSERT INTO "CosmeticShopItem" ("id", "title") VALUES ($1, $2)`, [id, `item ${id}`])
    )
  );

const seedPurchases = (userId: number, shopItemId: number, daysAgo: number, count = 1) =>
  db.query(
    `INSERT INTO "UserCosmeticShopPurchases" ("buzzTransactionId", "userId", "shopItemId", "purchasedAt")
     SELECT 'charge-' || $1::int || '-' || $2::int || '-' || $3::int || '-' || n, $1::int, $2::int,
            now() - make_interval(days => $3::int)
     FROM generate_series(1, $4::int) AS n`,
    [userId, shopItemId, daysAgo, count]
  );

const itemCounts = (account: { items: { shopItemId: number; count: number }[] }) =>
  Object.fromEntries(account.items.map((i) => [i.shopItemId, i.count]));

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('shop_purchases window', () => {
  beforeEach(async () => {
    await seedItems(1, 2);
    await seedPurchases(BUYER, 1, 6);
    await seedPurchases(BUYER, 2, 8);
  });

  it('leaves out a purchase older than the window', async () => {
    const { accounts } = await getShopPurchaseSummary([BUYER], 7);

    expect(itemCounts(accounts[0])).toEqual({ 1: 1 });
  });

  it('includes that purchase once the window reaches it', async () => {
    const { accounts } = await getShopPurchaseSummary([BUYER], 9);

    expect(itemCounts(accounts[0])).toEqual({ 1: 1, 2: 1 });
  });
});

describe('shop_purchases recency cap', () => {
  beforeEach(async () => {
    await seedItems(1, 2, 3);
    await seedPurchases(BUYER, 1, 1, ROW_CAP);
    await seedPurchases(BUYER, 2, 2);
    await seedPurchases(OTHER_BUYER, 3, 3, 2);
  });

  it("keeps an account's newest rows and drops the older one past the cap", async () => {
    const { accounts, truncated } = await getShopPurchaseSummary([BUYER], 30);

    expect(itemCounts(accounts[0])).toEqual({ 1: ROW_CAP });
    expect(accounts[0].truncated).toBe(true);
    expect(truncated).toBe(true);
  });

  it("counts the cap per account, so one busy buyer does not crowd out another's rows", async () => {
    const { accounts } = await getShopPurchaseSummary([BUYER, OTHER_BUYER], 30);
    const other = accounts.find((a) => a.userId === OTHER_BUYER);

    expect(other && itemCounts(other)).toEqual({ 3: 2 });
    expect(other?.truncated).toBe(false);
  });
});
