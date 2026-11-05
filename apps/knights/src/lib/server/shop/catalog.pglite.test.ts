import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedPlayer } from '../../../test/seed';
import { loadShop } from './catalog';

const NOW = new Date('2026-12-20T12:00:00Z');

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
    `TRUNCATE "KnightsShopPurchase","KnightsShopItem","NewOrderPlayer","CustomerSubscription","Product" RESTART IDENTITY CASCADE`
  );
  await pg.exec(`
    INSERT INTO "KnightsShopItem" ("id","kind","name","price","tier","months") VALUES
      ('member-silver','membership','Silver',12000,'silver',1),
      ('member-gold-3m','membership','Gold x3',90000,'gold',3);
    INSERT INTO "Product" ("id","metadata") VALUES ('p-bronze', '{"tier":"bronze"}');`);
  await seedPlayer(pg, 1);
});

const cards = async () =>
  (await loadShop(db, { playerId: 1, rank: 'Knight', now: NOW, buzzPacksOpen: true })).cards;

describe('the shop view of a membership', () => {
  it('offers a month to a player with no membership, and does not list one that is not a single month', async () => {
    expect((await cards()).map((card) => [card.id, card.state])).toEqual([
      ['member-silver', 'available'],
    ]);
  });

  it('marks it as already a member while any membership is running, whatever it was bought with', async () => {
    await pg.exec(`INSERT INTO "CustomerSubscription" ("id","userId","productId","status","currentPeriodEnd")
      VALUES ('s1', 1, 'p-bronze', 'active', '2027-01-20')`);
    expect((await cards())[0].state).toBe('member');
  });

  it('offers a month again once the membership has run out', async () => {
    await pg.exec(`INSERT INTO "CustomerSubscription" ("id","userId","productId","status","currentPeriodEnd")
      VALUES ('s1', 1, 'p-bronze', 'active', '2026-12-01')`);
    expect((await cards())[0].state).toBe('available');
  });
});
