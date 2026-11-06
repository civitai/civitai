import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createQueueDb } from '../../../test/pglite-kysely';
import { FIXED_ITEMS, cosmeticItems, pickCosmetics, seedSql } from './seed-items';

let pg: PGlite;

beforeAll(async () => {
  ({ pg } = await createQueueDb());
});
afterAll(async () => {
  await pg.close();
});

const rows = [
  { id: 1, name: "Knight's Seal", type: 'Badge' },
  { id: 2, name: 'Second Badge', type: 'Badge' },
  { id: 3, name: 'Third Badge', type: 'Badge' },
  { id: 4, name: 'Gilded', type: 'NamePlate' },
  { id: 5, name: 'Halo', type: 'ProfileDecoration' },
  { id: 6, name: 'Laurel', type: 'ProfileDecoration' },
  { id: 7, name: 'Wave', type: 'Sticker' },
];

const seedCosmetics = (cosmetics: { id: number; name: string; type: string }[]) =>
  pg.query(
    `INSERT INTO "Cosmetic" ("id","name","type","source","data")
     SELECT id, name, type, 'Purchase', '{}' FROM jsonb_to_recordset($1::jsonb) AS t(id int, name text, type text)`,
    [JSON.stringify(cosmetics)]
  );

beforeEach(async () => {
  await pg.exec(`TRUNCATE "KnightsShopItem","Cosmetic" RESTART IDENTITY CASCADE`);
});

describe('the dev shop seed', () => {
  it('satisfies the table constraints, and seeding again changes nothing, not even an edited price', async () => {
    await seedCosmetics(rows);
    const sql = seedSql([...FIXED_ITEMS, ...cosmeticItems(pickCosmetics(rows))]);
    await pg.exec(sql);
    const count = async () =>
      (await pg.query<{ n: number }>(`SELECT count(*)::int n FROM "KnightsShopItem"`)).rows[0].n;
    const first = await count();
    await pg.exec(
      `UPDATE "KnightsShopItem" SET "price" = 777 WHERE "kind" = 'buzz_pack' AND "buzz" = 50`
    );

    await pg.exec(sql);

    expect(await count()).toBe(first);
    expect(
      (
        await pg.query<{ price: number }>(
          `SELECT "price" FROM "KnightsShopItem" WHERE "kind" = 'buzz_pack' AND "buzz" = 50`
        )
      ).rows[0].price
    ).toBe(777);
  });

  it("sells the design's four Buzz packs and a week of each tier", () => {
    expect(FIXED_ITEMS.filter((i) => i.kind === 'buzz_pack').map((i) => [i.buzz, i.price])).toEqual(
      [
        [50, 1000],
        [130, 2500],
        [275, 5000],
        [600, 10000],
      ]
    );
    expect(
      FIXED_ITEMS.filter((i) => i.kind === 'membership').map((i) => [i.tier, i.days, i.price])
    ).toEqual([
      ['bronze', 7, 60_000],
      ['silver', 7, 150_000],
      ['gold', 7, 300_000],
    ]);
  });

  it('keeps an apostrophe in a cosmetic name', async () => {
    const seal = { id: 90, name: "Knight's Seal", type: 'Badge' };
    await seedCosmetics([seal]);
    await pg.exec(seedSql(cosmeticItems([seal])));
    const row = (
      await pg.query<{ name: string }>(`SELECT name FROM "KnightsShopItem" WHERE "cosmeticId" = 90`)
    ).rows[0];
    expect(row.name).toBe("Knight's Seal");
  });

  it("finds each cosmetic by name and type in the database it runs on, not by the seeding database's ids", async () => {
    const sql = seedSql(cosmeticItems(pickCosmetics(rows)));
    await seedCosmetics([
      { id: 501, name: 'Halo', type: 'ProfileDecoration' },
      { id: 502, name: 'Wave', type: 'Sticker' },
    ]);

    await pg.exec(sql);

    expect(
      (
        await pg.query<{ cosmeticId: number }>(
          `SELECT "cosmeticId" FROM "KnightsShopItem" ORDER BY "cosmeticId"`
        )
      ).rows
    ).toEqual([{ cosmeticId: 501 }, { cosmeticId: 502 }]);
  });

  it('prices decorations in three steps, gated to ranks from the second', () => {
    const decorations = ['One', 'Two', 'Three'].map((name, i) => ({
      id: 20 + i,
      name,
      type: 'ProfileDecoration',
    }));
    const items = cosmeticItems(decorations);
    expect(items.map((i) => [i.price, i.minRank])).toEqual([
      [25_000, undefined],
      [50_000, 'Templar'],
      [80_000, 'Paladin'],
    ]);
  });

  it('prices a sticker at 100 gold per use and the other cosmetics at the sheet', () => {
    const items = cosmeticItems([
      { id: 30, name: 'Ten uses', type: 'Sticker', data: { uses: 10 } },
      { id: 31, name: 'Badge', type: 'Badge' },
      { id: 32, name: 'Plate', type: 'NamePlate' },
    ]);
    expect(items.map((i) => [i.cosmeticType, i.price])).toEqual([
      ['Badge', 15_000],
      ['NamePlate', 30_000],
      ['Sticker', 1_000],
    ]);
  });
});
