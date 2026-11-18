import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { STREAK_BADGE_IDS } from '../daily/streak-badges';
import { hasActiveMembership, listInventory, membershipOf, recentPurchases } from './inventory';

const NOW = new Date('2026-12-20T12:00:00Z');
const ACOLYTE_BADGE = 858;
const ITEM = {
  'badge-seal': 1,
  'sticker-wave': 2,
  'sticker-free': 3,
  'buzz-50': 4,
  'acolyte-resale': 5,
} as const;
type ItemName = keyof typeof ITEM;

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsShopPurchase","KnightsShopItem","UserCosmetic","Cosmetic","CustomerSubscription","Product" RESTART IDENTITY CASCADE`
  );
  await pg.exec(`
    INSERT INTO "KnightsShopItem" ("id","kind","name","price","buzz","cosmeticId","tier","days") VALUES
      (1,'cosmetic','Seal badge',400,NULL,101,NULL,NULL),
      (2,'cosmetic','Wave stickers',300,NULL,102,NULL,NULL),
      (3,'cosmetic','Free stickers',300,NULL,103,NULL,NULL),
      (4,'buzz_pack','50 Buzz',1000,50,NULL,NULL,NULL);
    INSERT INTO "Cosmetic" ("id","name","type","source","data") VALUES
      (101,'Seal','Badge','Purchase','{"url":"seal-key"}'),
      (102,'Wave','Sticker','Purchase','{"uses":5}'),
      (103,'Free','Sticker','Purchase','{}'),
      (104,'Gift','Badge','Manual','{}'),
      (${ACOLYTE_BADGE},'Acolyte','Badge','Claimable','{}');`);
});

let n = 0;
/** Records a purchase and returns its key, which is also the `claimKey` of what it granted. */
const buy = async (item: ItemName, { playerId = 1, status = 'granted' } = {}) => {
  const key = `purchase-${++n}`;
  await pg.query(
    `INSERT INTO "KnightsShopPurchase" ("playerId","requestKey","externalKey","itemId","kind","gold","grant","status")
     SELECT $1, $2, $2, $3, "kind", "price", '{}', $4 FROM "KnightsShopItem" WHERE "id" = $3`,
    [playerId, key, ITEM[item], status]
  );
  return key;
};
const own = (
  cosmeticId: number,
  claimKey: string,
  { remaining = null as number | null, equipped = false, userId = 1 } = {}
) =>
  pg.query(
    `INSERT INTO "UserCosmetic" ("userId","cosmeticId","claimKey","remaining","equippedAt") VALUES ($1,$2,$3,$4,$5)`,
    [userId, cosmeticId, claimKey, remaining, equipped ? NOW.toISOString() : null]
  );
const inventory = async () => listInventory(db, 1);

describe('listInventory', () => {
  it('lists shop purchases and rank badges, and nothing else the player owns', async () => {
    await own(101, await buy('badge-seal'));
    await own(ACOLYTE_BADGE, 'rank-grant');
    await own(104, 'gift-claim');

    expect(
      (await inventory()).map(({ cosmeticId, origin, imageKey }) => [cosmeticId, origin, imageKey])
    ).toEqual([
      [ACOLYTE_BADGE, 'rank', null],
      [101, 'shop', 'seal-key'],
    ]);
  });

  it('lists an earned streak badge', async () => {
    const shipped = { ...STREAK_BADGE_IDS };
    Object.assign(STREAK_BADGE_IDS, { 7: 105 });
    try {
      await pg.exec(
        `INSERT INTO "Cosmetic" ("id","name","type","source","data") VALUES (105,'Week','Badge','Trophy','{}')`
      );
      await own(105, 'streak-grant');

      expect(await inventory()).toMatchObject([{ cosmeticId: 105, origin: 'streak' }]);
    } finally {
      Object.assign(STREAK_BADGE_IDS, shipped);
    }
  });

  it("leaves out another player's cosmetic and a holding no shop purchase put there", async () => {
    await own(101, await buy('badge-seal', { playerId: 2 }), { userId: 2 });
    await own(101, 'claim-never-bought');

    expect(await inventory()).toEqual([]);
  });

  it('adds up the uses of a sticker bought more than once', async () => {
    await own(102, await buy('sticker-wave'), { remaining: 5 });
    await own(102, await buy('sticker-wave'), { remaining: 3 });

    expect(await inventory()).toMatchObject([{ cosmeticId: 102, type: 'Sticker', uses: 8 }]);
  });

  it('collapses a stack holding one unlimited sticker to unlimited', async () => {
    await own(103, await buy('sticker-free'), { remaining: null });
    await own(103, await buy('sticker-free'), { remaining: 4 });

    expect(await inventory()).toMatchObject([{ cosmeticId: 103, uses: null }]);
  });

  it('shows a non-sticker without a use count', async () => {
    await own(101, await buy('badge-seal'));

    expect((await inventory())[0].uses).toBeNull();
  });

  it('calls a rank badge the player also bought a shop item', async () => {
    await own(ACOLYTE_BADGE, 'rank-grant');
    await pg.query(
      `INSERT INTO "KnightsShopItem" ("id","kind","name","price","cosmeticId") VALUES (5,'cosmetic','Acolyte',100,${ACOLYTE_BADGE})`
    );
    await own(ACOLYTE_BADGE, await buy('acolyte-resale'));

    expect(await inventory()).toMatchObject([{ cosmeticId: ACOLYTE_BADGE, origin: 'shop' }]);
  });

  it('is equipped when any holding of it is equipped', async () => {
    await own(102, await buy('sticker-wave'), { remaining: 5 });
    await own(102, await buy('sticker-wave'), { remaining: 5, equipped: true });

    expect(await inventory()).toMatchObject([{ cosmeticId: 102, equipped: true }]);
  });

  it('is not equipped when no holding is', async () => {
    await own(101, await buy('badge-seal'));

    expect((await inventory())[0].equipped).toBe(false);
  });
});

describe('recentPurchases', () => {
  it('lists the newest first with the item name and kind, and only the player’s own', async () => {
    await buy('badge-seal');
    await buy('buzz-50', { status: 'pending' });
    await buy('badge-seal', { playerId: 2 });

    expect(
      (await recentPurchases(db, 1)).map(({ name, kind, status, gold }) => [
        name,
        kind,
        status,
        gold,
      ])
    ).toEqual([
      ['50 Buzz', 'buzz_pack', 'pending', 1000],
      ['Seal badge', 'cosmetic', 'granted', 400],
    ]);
  });

  it('stops at the limit', async () => {
    await buy('badge-seal');
    await buy('buzz-50');
    await buy('sticker-wave');

    expect((await recentPurchases(db, 1, 2)).map((row) => row.name)).toEqual([
      'Wave stickers',
      '50 Buzz',
    ]);
  });
});

describe('membership', () => {
  const subscribe = (
    id: string,
    { status = 'active', end = '2027-01-20', metadata = '{"tier":"silver"}' } = {}
  ) =>
    pg.exec(`
      INSERT INTO "Product" ("id","metadata") VALUES ('p-${id}', '${metadata}');
      INSERT INTO "CustomerSubscription" ("id","userId","productId","status","currentPeriodEnd")
        VALUES ('${id}', 1, 'p-${id}', '${status}', '${end}');`);

  it('reports the live subscription with its tier and end', async () => {
    await subscribe('s1');

    expect(await membershipOf(db, 1, NOW)).toEqual({
      tier: 'silver',
      endsAt: new Date('2027-01-20T00:00:00Z'),
    });
    expect(await hasActiveMembership(db, 1, NOW)).toBe(true);
  });

  it('reports a live subscription whose product names no tier, with the tier unknown', async () => {
    await subscribe('s1', { metadata: '{}' });

    expect(await membershipOf(db, 1, NOW)).toMatchObject({ tier: null });
    expect(await hasActiveMembership(db, 1, NOW)).toBe(true);
  });

  it.each([
    ['cancelled', { status: 'canceled' }],
    ['expired', { end: '2026-12-01' }],
  ])('reports nothing for a %s subscription', async (_, over) => {
    await subscribe('s1', over);

    expect(await membershipOf(db, 1, NOW)).toBeNull();
    expect(await hasActiveMembership(db, 1, NOW)).toBe(false);
  });
});
