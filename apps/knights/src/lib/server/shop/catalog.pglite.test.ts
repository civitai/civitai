import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedPlayer } from '../../../test/seed';
import { loadShop } from './catalog';
import { addCreatorShopStandIns } from './creator-cosmetic.fixture';

const NOW = new Date('2026-12-20T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await addCreatorShopStandIns(pg);
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsShopPurchase","KnightsShopItem","NewOrderPlayer","CustomerSubscription","Product" RESTART IDENTITY CASCADE`
  );
  await pg.exec(`
    INSERT INTO "KnightsShopItem" ("id","kind","name","price","tier","days") VALUES
      (1,'membership','Silver',12000,'silver',7),
      (2,'membership','Gold x30',90000,'gold',30);
    INSERT INTO "Product" ("id","metadata") VALUES ('p-bronze', '{"tier":"bronze"}');`);
  await seedPlayer(pg, 1);
});

const cards = async () =>
  (await loadShop(db, { playerId: 1, rank: 'Knight', now: NOW, buzzPacksOpen: true })).cards;

describe('the shop view of a membership', () => {
  it('offers a week to a player with no membership, and does not list one that is not a single week', async () => {
    expect((await cards()).map((card) => [card.id, card.state])).toEqual([[1, 'available']]);
  });

  it('marks it as already a member while any membership is running, whatever it was bought with', async () => {
    await pg.exec(`INSERT INTO "CustomerSubscription" ("id","userId","productId","status","currentPeriodEnd")
      VALUES ('s1', 1, 'p-bronze', 'active', '2027-01-20')`);
    expect((await cards())[0].state).toBe('member');
  });

  it('offers a week again once the membership has run out', async () => {
    await pg.exec(`INSERT INTO "CustomerSubscription" ("id","userId","productId","status","currentPeriodEnd")
      VALUES ('s1', 1, 'p-bronze', 'active', '2026-12-01')`);
    expect((await cards())[0].state).toBe('available');
  });
});

describe('the shop view of a creator cosmetic', () => {
  beforeEach(async () => {
    await pg.exec(`
      TRUNCATE "Cosmetic","CosmeticShopItem","User" RESTART IDENTITY CASCADE;
      INSERT INTO "User" ("id") VALUES (50);
      INSERT INTO "Cosmetic" ("id","name","type","source","data","createdById") VALUES
        (105,'Creator badge','Badge','Purchase','{}',50);
      INSERT INTO "CosmeticShopItem" ("id","cosmeticId","unitAmount","addedById","title","status") VALUES
        (1,105,100,50,'Creator badge','PendingReview');
      INSERT INTO "KnightsShopItem" ("id","kind","name","price","cosmeticId") VALUES
        (3,'cosmetic','Creator badge',500,105);`);
  });

  it('does not list it while the creator listing is in review, and lists it once approved', async () => {
    expect((await cards()).map((card) => card.id)).toEqual([1]);
    await pg.exec(`UPDATE "CosmeticShopItem" SET "status"='Published' WHERE "id"=1`);
    expect((await cards()).map((card) => card.id)).toEqual([1, 3]);
  });

  it('gives its rotation slot to an approved item', async () => {
    await pg.exec(`INSERT INTO "KnightsShopItem" ("id","kind","name","price","tier","days","rotating") VALUES
      (10,'membership','Gold wk',90000,'gold',7,true),
      (11,'membership','Gold wk 2',90000,'gold',7,true),
      (12,'membership','Gold wk 3',90000,'gold',7,true),
      (13,'membership','Gold wk 4',90000,'gold',7,true);
      UPDATE "KnightsShopItem" SET "rotating" = true WHERE "id" = 3;`);
    const ids = (await cards()).map((card) => card.id);
    expect(ids).not.toContain(3);
    expect(ids.filter((id) => id >= 10)).toHaveLength(4);
  });
});
