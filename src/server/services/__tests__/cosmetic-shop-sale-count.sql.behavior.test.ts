import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { countShopItemSale } from '~/server/services/cosmetic-shop-sale-count';

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
