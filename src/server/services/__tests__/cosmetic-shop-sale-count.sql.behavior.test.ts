import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type { dbWrite } from '~/server/db/client';
import {
  countShopItemSale,
  countShopItemSaleAfterGrant,
  setShopItemSaleCount,
} from '~/server/services/cosmetic-shop-sale-count';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The sale counter, run as written against an in-process Postgres: what it keeps and adds lives in
 * the SQL, which a mocked client cannot see.
 */

const db = { pg: null as unknown as PGlite };
const tx = () =>
  ({ $executeRaw: pgliteRaw(db.pg).executeRaw } as unknown as Prisma.TransactionClient);
const meta = async (id: number) =>
  (
    await db.pg.query<{ meta: unknown }>(`SELECT "meta" FROM "CosmeticShopItem" WHERE "id" = $1`, [
      id,
    ])
  ).rows[0].meta;
const setMeta = (id: number, value: unknown) =>
  db.pg.query(`UPDATE "CosmeticShopItem" SET "meta" = $2::jsonb WHERE "id" = $1`, [
    id,
    JSON.stringify(value),
  ]);

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "CosmeticShopItem" ("id" INTEGER PRIMARY KEY, "meta" JSONB NOT NULL DEFAULT '{}');
    INSERT INTO "CosmeticShopItem" ("id") VALUES (1), (2);
  `);
});
afterAll(() => db.pg.close());
beforeEach(() => setMeta(1, { purchases: 4, label: 'a', flag: true }));

describe('countShopItemSale', () => {
  it('keeps the other meta keys as the row has them', async () => {
    await setMeta(1, { purchases: 4, label: 'b', flag: false });

    await countShopItemSale(tx(), 1);

    expect(await meta(1)).toEqual({ purchases: 5, label: 'b', flag: false });
  });

  it('counts from the current row, so two sales add two', async () => {
    await countShopItemSale(tx(), 1);
    await countShopItemSale(tx(), 1);

    expect(await meta(1)).toEqual({ purchases: 6, label: 'a', flag: true });
  });

  it.each([
    ['no purchases key', { label: 'a' }, { label: 'a', purchases: 1 }],
    ['an empty meta', {}, { purchases: 1 }],
    ['a meta that is not an object', null, { purchases: 1 }],
    ['a null purchases', { purchases: null }, { purchases: 1 }],
    ['a purchases that is not a number', { purchases: '3' }, { purchases: 1 }],
  ])('starts the count at one on %s', async (_label, start, expected) => {
    await setMeta(1, start);

    await countShopItemSale(tx(), 1);

    expect(await meta(1)).toEqual(expected);
  });

  it('touches only the listing it names', async () => {
    await setMeta(2, { purchases: 9 });

    await countShopItemSale(tx(), 1);

    expect(await meta(2)).toEqual({ purchases: 9 });
  });
});

describe('countShopItemSaleAfterGrant', () => {
  const runner = {
    $transaction: async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) => {
      await db.pg.exec('BEGIN');
      try {
        const result = await fn(tx());
        await db.pg.exec('COMMIT');
        return result;
      } catch (error) {
        await db.pg.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Pick<typeof dbWrite, '$transaction'>;
  const seen = async () =>
    (await db.pg.query<{ value: string }>(`SELECT "value" FROM "LockTimeoutSeen"`)).rows.map(
      (r) => r.value
    );

  // PGlite has one session, so no second buyer can hold the row; the timeout's effect is read off
  // the update itself instead: what `lock_timeout` was while it ran, and after its transaction.
  beforeAll(async () => {
    await db.pg.exec(`
      CREATE TABLE "LockTimeoutSeen" ("value" TEXT NOT NULL);
      CREATE FUNCTION record_lock_timeout() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO "LockTimeoutSeen" VALUES (current_setting('lock_timeout'));
        RETURN NEW;
      END $$;
      CREATE TRIGGER record_lock_timeout BEFORE UPDATE ON "CosmeticShopItem"
        FOR EACH ROW EXECUTE FUNCTION record_lock_timeout();
    `);
  });
  afterAll(() =>
    db.pg.exec(`
      DROP TRIGGER record_lock_timeout ON "CosmeticShopItem";
      DROP FUNCTION record_lock_timeout();
      DROP TABLE "LockTimeoutSeen";
    `)
  );
  beforeEach(() => db.pg.exec(`DELETE FROM "LockTimeoutSeen"`));

  it('counts the sale under a lock timeout that ends with its transaction', async () => {
    await countShopItemSaleAfterGrant(1, runner);

    expect(await meta(1)).toEqual({ purchases: 5, label: 'a', flag: true });
    // Some bound while the row is written, whatever its value; none once the transaction ends.
    const during = await seen();
    expect(during).toHaveLength(1);
    expect(during[0]).not.toBe('0');
    const [{ lock_timeout }] = (await db.pg.query<{ lock_timeout: string }>('SHOW lock_timeout'))
      .rows;
    expect(lock_timeout).toBe('0');
  });
});

describe('setShopItemSaleCount', () => {
  it('sets the counted total and keeps the other meta keys as the row has them', async () => {
    await setMeta(1, { purchases: 2, label: 'b', flag: false });

    await setShopItemSaleCount(tx(), 1, 7);

    expect(await meta(1)).toEqual({ purchases: 7, label: 'b', flag: false });
  });

  it('touches only the listing it names', async () => {
    await setMeta(2, { purchases: 9 });

    await setShopItemSaleCount(tx(), 1, 7);

    expect(await meta(2)).toEqual({ purchases: 9 });
  });
});
