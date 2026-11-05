import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedPlayer, setGold } from '../../../test/seed';
import { getGoldBalance } from '../conversion/balance';
import { BuzzRejectedError, type BuzzGrant, type BuzzPort } from '../conversion/buzz';
import { markConversionPaid, retryPendingConversions } from '../conversion/convert';
import { MainAppRejectedError, type MainAppPort } from './main-app';
import { buyItem, retryPendingPurchases, type BuyDeps } from './purchase';
import { stockFor } from './rotation';

const dealsToday = vi.hoisted(() => ({ count: 0 }));
vi.mock('./config', async (original) => ({
  ...(await original<typeof import('./config')>()),
  get DEALS_PER_DAY() {
    return dealsToday.count;
  },
}));

const NOW = new Date('2026-12-20T12:00:00Z');
const DAY = '2026-12-20';

let pg: PGlite;
let db: Kysely<DB>;

function fakeBuzz({ failFirst = false, reject = false } = {}) {
  const paid = new Map<string, number>();
  let calls = 0;
  const grantYellow = vi.fn<BuzzPort['grantYellow']>(async (grant: BuzzGrant) => {
    calls++;
    if (reject) throw new BuzzRejectedError(400);
    if (failFirst && calls === 1) throw new Error('buzz down');
    paid.set(grant.externalTransactionId, grant.amount);
    return { transactionId: `tx-${paid.size}` };
  });
  return { port: { grantYellow } as BuzzPort, grantYellow, paid };
}

function fakeMainApp({ failFirst = false, down = false, reject = null as number | null } = {}) {
  const memberships = new Map<string, { userId: number; tier: string }>();
  let calls = 0;
  const grantMembership = vi.fn<MainAppPort['grantMembership']>(async (grant) => {
    calls++;
    if (reject) throw new MainAppRejectedError(reject, 'queue-full');
    if (down || (failFirst && calls === 1)) throw new Error('main app down');
    const known = memberships.has(grant.key);
    memberships.set(grant.key, grant);
    return { outcome: known ? 'already' : 'granted' };
  });
  const refreshCosmetics = vi.fn<MainAppPort['refreshCosmetics']>(async () => undefined);
  const equipCosmetic = vi.fn<MainAppPort['equipCosmetic']>(async () => undefined);
  const unequipCosmetic = vi.fn<MainAppPort['unequipCosmetic']>(async () => undefined);
  return {
    port: { grantMembership, refreshCosmetics, equipCosmetic, unequipCosmetic } as MainAppPort,
    grantMembership,
    refreshCosmetics,
    memberships,
  };
}

const ITEMS = `
INSERT INTO "KnightsShopItem" ("id","kind","name","price","buzz","cosmeticId","tier","months","minRank","rotating") VALUES
 ('buzz-50','buzz_pack','50 Buzz',1000,50,NULL,NULL,NULL,NULL,false),
 ('buzz-130','buzz_pack','130 Buzz',2500,130,NULL,NULL,NULL,NULL,false),
 ('member-silver','membership','Silver',12000,NULL,NULL,'silver',1,NULL,false),
 ('badge-seal','cosmetic','Seal badge',400,NULL,101,NULL,NULL,NULL,false),
 ('sticker-wave','cosmetic','Wave stickers',300,NULL,102,NULL,NULL,NULL,false),
 ('sticker-free','cosmetic','Free stickers',300,NULL,103,NULL,NULL,NULL,false),
 ('halo','cosmetic','Halo',2000,NULL,104,NULL,NULL,'Paladin',false);
INSERT INTO "Cosmetic" ("id","name","type","source","data") VALUES
 (101,'Seal','Badge','Purchase','{}'),
 (102,'Wave','Sticker','Purchase','{"uses":5}'),
 (103,'Free','Sticker','Purchase','{}'),
 (104,'Halo','ProfileDecoration','Purchase','{}');`;

const defaultDeps = (over: Partial<BuyDeps> = {}): BuyDeps => ({
  buzz: fakeBuzz().port,
  mainApp: fakeMainApp().port,
  buzzPacksOpen: true,
  ...over,
});

let keyCounter = 0;
const buy = (
  itemId: string,
  {
    playerId = 1,
    price,
    key,
    deps = defaultDeps(),
    now = NOW,
  }: {
    playerId?: number;
    price?: number;
    key?: string;
    deps?: BuyDeps;
    now?: Date;
  } = {}
) =>
  buyItem(db, deps, {
    playerId,
    itemId,
    requestKey: key ?? `request-${++keyCounter}`,
    price: price ?? PRICES[itemId],
    now,
  });

const PRICES: Record<string, number> = {
  'buzz-50': 1000,
  'buzz-130': 2500,
  'member-silver': 12000,
  'badge-seal': 400,
  'sticker-wave': 300,
  'sticker-free': 300,
  halo: 2000,
};

const player = async (userId = 1) =>
  (
    await pg.query<{ goldEarned: number; goldConverted: number }>(
      `SELECT "goldEarned","goldConverted" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [userId]
    )
  ).rows[0];
const purchases = async () =>
  (await pg.query<Record<string, unknown>>(`SELECT * FROM "KnightsShopPurchase" ORDER BY id`)).rows;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb({ serialize: true }));
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  dealsToday.count = 0;
  await pg.exec(
    `TRUNCATE "KnightsShopPurchase","KnightsShopItem","KnightsGoldConversion","UserCosmetic","Cosmetic","NewOrderPlayer","User","CustomerSubscription","Product" RESTART IDENTITY CASCADE`
  );
  await pg.exec(ITEMS);
  await seedPlayer(pg, 1, 'Knight');
  await setGold(pg, 1, { earned: 20_000 });
});

describe('a Buzz pack', () => {
  it('spends its gold, grants the Buzz once under the conversion machinery, and shows as granted', async () => {
    const buzz = fakeBuzz();
    const result = await buy('buzz-50', { deps: defaultDeps({ buzz: buzz.port }) });

    expect(result).toMatchObject({ status: 'granted', buzz: 50, gold: 1000, replayed: false });
    expect(buzz.grantYellow).toHaveBeenCalledTimes(1);
    expect(buzz.grantYellow.mock.calls[0][0]).toMatchObject({ userId: 1, amount: 50 });
    expect(await player()).toMatchObject({ goldEarned: 20_000, goldConverted: 1000 });
    const [purchase] = await purchases();
    expect(purchase).toMatchObject({ status: 'granted', kind: 'buzz_pack', gold: 1000 });
    const conversion = (await pg.query(`SELECT * FROM "KnightsGoldConversion"`)).rows[0] as Record<
      string,
      unknown
    >;
    expect(conversion).toMatchObject({
      status: 'paid',
      gold: 1000,
      buzz: 50,
      id: purchase.conversionId,
    });
  });

  it('keeps the gold reserved when Buzz is down, and the tick retry pays it once with the same key', async () => {
    const buzz = fakeBuzz({ failFirst: true });
    const result = await buy('buzz-50', { deps: defaultDeps({ buzz: buzz.port }) });
    expect(result).toMatchObject({ status: 'pending' });
    expect((await purchases())[0].status).toBe('pending');
    expect(await player()).toMatchObject({ goldConverted: 1000 });

    const later = new Date(NOW.getTime() + 5 * 60_000);
    await retryPendingConversions(db, buzz.port, { now: later });
    await retryPendingConversions(db, buzz.port, { now: later });

    expect((await purchases())[0].status).toBe('granted');
    expect(buzz.paid.size).toBe(1);
    expect(await player()).toMatchObject({ goldConverted: 1000 });
  });

  it('gives the gold back and marks the purchase failed when Buzz refuses it for good', async () => {
    const result = await buy('buzz-50', {
      deps: defaultDeps({ buzz: fakeBuzz({ reject: true }).port }),
    });

    expect(result).toMatchObject({ status: 'failed', forfeited: false });
    expect((await purchases())[0].status).toBe('failed');
    expect(await player()).toMatchObject({ goldConverted: 0 });
  });

  it('is refused while the Buzz kill switch is on, and cosmetics still sell', async () => {
    const buzz = fakeBuzz();
    const deps = defaultDeps({ buzz: buzz.port, buzzPacksOpen: false });

    expect(await buy('buzz-50', { deps })).toEqual({ status: 'refused', reason: 'closed' });
    expect(buzz.grantYellow).not.toHaveBeenCalled();
    expect(await player()).toMatchObject({ goldConverted: 0 });
    expect(await buy('badge-seal', { deps })).toMatchObject({ status: 'granted' });
  });

  it('leaves a pending pack alone, asking Buzz for nothing, when a replay arrives with the kill switch on', async () => {
    const down = fakeBuzz({ failFirst: true });
    await buy('buzz-50', { key: 'closed-replay', deps: defaultDeps({ buzz: down.port }) });
    const buzz = fakeBuzz();

    const replay = await buy('buzz-50', {
      key: 'closed-replay',
      deps: defaultDeps({ buzz: buzz.port, buzzPacksOpen: false }),
    });

    expect(replay).toMatchObject({ status: 'pending', replayed: true });
    expect(buzz.grantYellow).not.toHaveBeenCalled();
  });

  it('loses a pending pack to a career reset the way a conversion does, and does not give it back', async () => {
    const buzz = fakeBuzz({ failFirst: true });
    await buy('buzz-50', { deps: defaultDeps({ buzz: buzz.port }) });
    // the reset: unspent gold is forfeited, startAt moves past the reservation
    await pg.query(
      `UPDATE "NewOrderPlayer" SET "goldEarned" = "goldConverted", "startAt" = clock_timestamp() + interval '1 second' WHERE "userId"=1`
    );

    await retryPendingConversions(db, fakeBuzz({ reject: true }).port, {
      now: new Date(NOW.getTime() + 5 * 60_000),
    });

    expect((await purchases())[0].status).toBe('failed');
    expect(await player()).toMatchObject({ goldEarned: 0, goldConverted: 0 });
    expect((await getGoldBalance(db, 1)).convertible).toBe(0);
  });
});

describe('spending gold', () => {
  it('replays a repeated request key without charging or granting twice', async () => {
    const buzz = fakeBuzz();
    const deps = defaultDeps({ buzz: buzz.port });
    const first = await buy('buzz-50', { key: 'same-request', deps });
    const again = await buy('buzz-50', { key: 'same-request', deps });

    expect(again).toMatchObject({
      status: 'granted',
      replayed: true,
      purchaseId: (first as { purchaseId: number }).purchaseId,
    });
    expect(buzz.grantYellow).toHaveBeenCalledTimes(1);
    expect(await purchases()).toHaveLength(1);
    expect(await player()).toMatchObject({ goldConverted: 1000 });
  });

  it('charges once when the same request is sent twice back to back (the harness runs the two transactions in turn)', async () => {
    const results = await Promise.all([
      buy('badge-seal', { key: 'twin-request' }),
      buy('badge-seal', { key: 'twin-request' }),
    ]);

    expect(results.map((r) => r.status)).toEqual(['granted', 'granted']);
    expect(await purchases()).toHaveLength(1);
    expect(await player()).toMatchObject({ goldConverted: 400 });
  });

  it("lets only one of two purchases spend gold that covers one: the second reads the first one's spend (the harness runs them in turn; the row lock itself needs a real Postgres)", async () => {
    await setGold(pg, 1, { earned: 1000 });
    const results = await Promise.all([buy('buzz-50'), buy('buzz-50')]);

    expect(results.map((r) => r.status).sort()).toEqual(['granted', 'refused']);
    expect(await player()).toMatchObject({ goldConverted: 1000 });
    expect(await purchases()).toHaveLength(1);
  });

  it('answers a replay of a charged purchase after the player is held, and again once the item is gone', async () => {
    const first = await buy('badge-seal', { key: 'replay-after-hold' });
    await pg.query(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt" = now() WHERE "userId"=1`);
    await pg.query(`UPDATE "KnightsShopItem" SET "active" = false WHERE "id" = 'badge-seal'`);

    const again = await buy('badge-seal', { key: 'replay-after-hold', price: 1 });

    expect(again).toMatchObject({
      status: 'granted',
      replayed: true,
      purchaseId: (first as { purchaseId: number }).purchaseId,
    });
    expect(await buy('halo')).toEqual({ status: 'refused', reason: 'held' });
  });

  it("keeps a held player's pending membership pending on a replay, without asking the main app", async () => {
    await buy('member-silver', {
      key: 'held-pending',
      deps: defaultDeps({ mainApp: fakeMainApp({ down: true }).port }),
    });
    await pg.query(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt" = now() WHERE "userId"=1`);
    const mainApp = fakeMainApp();

    const replay = await buy('member-silver', {
      key: 'held-pending',
      deps: defaultDeps({ mainApp: mainApp.port }),
    });

    expect(replay).toMatchObject({ status: 'pending', replayed: true });
    expect(mainApp.grantMembership).not.toHaveBeenCalled();
  });

  it('reports a replayed failed purchase as forfeited only when its gold was forfeited', async () => {
    const down = fakeMainApp({ down: true });
    await buy('member-silver', { key: 'forfeit-me', deps: defaultDeps({ mainApp: down.port }) });
    await buy('badge-seal', { key: 'release-me' });
    await pg.query(
      `UPDATE "NewOrderPlayer" SET "goldEarned" = "goldConverted", "startAt" = clock_timestamp() + interval '1 second' WHERE "userId"=1`
    );
    await retryPendingPurchases(db, fakeMainApp({ reject: 409 }).port, {
      now: new Date(NOW.getTime() + 5 * 60_000),
    });

    expect(await buy('member-silver', { key: 'forfeit-me' })).toMatchObject({
      status: 'failed',
      forfeited: true,
    });
  });

  it('reports a replayed failed purchase whose gold went back as not forfeited', async () => {
    const first = await buy('member-silver', {
      key: 'released',
      deps: defaultDeps({ mainApp: fakeMainApp({ reject: 409 }).port }),
    });
    expect(first).toMatchObject({ status: 'failed', forfeited: false });

    expect(await buy('member-silver', { key: 'released' })).toMatchObject({
      status: 'failed',
      forfeited: false,
    });
  });

  it('reports a replayed failed Buzz pack as forfeited when a reset took its gold', async () => {
    const buzz = fakeBuzz({ failFirst: true });
    await buy('buzz-50', { key: 'pack-forfeit', deps: defaultDeps({ buzz: buzz.port }) });
    await pg.query(
      `UPDATE "NewOrderPlayer" SET "goldEarned" = "goldConverted", "startAt" = clock_timestamp() + interval '1 second' WHERE "userId"=1`
    );
    await retryPendingConversions(db, fakeBuzz({ reject: true }).port, {
      now: new Date(NOW.getTime() + 5 * 60_000),
    });

    expect(await buy('buzz-50', { key: 'pack-forfeit' })).toMatchObject({
      status: 'failed',
      forfeited: true,
    });
  });

  it('refuses a held player and leaves the gold alone', async () => {
    await pg.query(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt" = now() WHERE "userId"=1`);

    expect(await buy('badge-seal')).toEqual({ status: 'refused', reason: 'held' });
    expect(await player()).toMatchObject({ goldConverted: 0 });
    expect(await purchases()).toHaveLength(0);
  });

  it('refuses a banned account the same way', async () => {
    await pg.query(`INSERT INTO "User" ("id","bannedAt") VALUES (1, now())`);
    expect(await buy('badge-seal')).toEqual({ status: 'refused', reason: 'held' });
  });

  it('refuses a player who never joined', async () => {
    expect(await buy('badge-seal', { playerId: 99 })).toEqual({
      status: 'refused',
      reason: 'no-player',
    });
  });

  it('says how short the gold is, and spends nothing', async () => {
    await setGold(pg, 1, { earned: 3200 });
    expect(await buy('member-silver')).toEqual({
      status: 'refused',
      reason: 'insufficient',
      shortfall: 8800,
    });
    expect(await player()).toMatchObject({ goldConverted: 0 });
  });

  it('spends only gold that is not already converted or reserved', async () => {
    await setGold(pg, 1, { earned: 1500, converted: 1000 });
    expect(await buy('buzz-50')).toEqual({
      status: 'refused',
      reason: 'insufficient',
      shortfall: 500,
    });
  });

  it('refuses a price the buyer did not see', async () => {
    expect(await buy('badge-seal', { price: 300 })).toEqual({
      status: 'refused',
      reason: 'price-changed',
    });
  });

  it('refuses an item that is not sold, and one gated to a higher rank', async () => {
    expect(await buy('nope', { price: 1 })).toEqual({ status: 'refused', reason: 'unknown-item' });
    await pg.query(`UPDATE "KnightsShopItem" SET "active" = false WHERE "id" = 'buzz-130'`);
    expect(await buy('buzz-130')).toEqual({ status: 'refused', reason: 'unknown-item' });
    expect(await buy('halo')).toEqual({ status: 'refused', reason: 'rank' });
    await pg.query(`UPDATE "NewOrderPlayer" SET "rankType" = 'Paladin' WHERE "userId"=1`);
    expect(await buy('halo')).toMatchObject({ status: 'granted' });
  });

  it("prices today's deal once per player per day, and calls it sold out afterwards", async () => {
    dealsToday.count = 1;
    const deal = stockFor(
      (await db.selectFrom('KnightsShopItem').selectAll().execute()).map((i) => ({ ...i })),
      DAY
    ).deals[0];
    const first = await buy(deal.item.id, { price: deal.price });
    expect(first).toMatchObject({ status: 'granted' });
    expect(deal.price).toBeLessThan(deal.item.price);
    expect(await buy(deal.item.id, { price: deal.price })).toEqual({
      status: 'refused',
      reason: 'sold-out',
    });
  });
});

describe('what the balance says after a purchase', () => {
  it('counts a granted cosmetic and a granted membership as spent, and a granted Buzz pack as converted', async () => {
    await buy('badge-seal');
    await buy('member-silver');
    await buy('buzz-50');

    expect(await getGoldBalance(db, 1)).toMatchObject({
      converted: 1000,
      spent: 12_400,
      onItsWay: 0,
      convertible: 20_000 - 1000 - 12_400,
    });
  });

  it('counts a membership the main app has not confirmed as on its way, not spent', async () => {
    await buy('member-silver', {
      deps: defaultDeps({ mainApp: fakeMainApp({ down: true }).port }),
    });

    expect(await getGoldBalance(db, 1)).toMatchObject({
      converted: 0,
      spent: 0,
      onItsWay: 12_000,
    });
  });
});

describe('a Buzz pack that is paid', () => {
  it('is granted in the same transaction as its conversion, so a failure between the two leaves both pending', async () => {
    const buzz = fakeBuzz();
    await pg.exec(`
      CREATE FUNCTION refuse_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'grant failed'; END $$;
      CREATE TRIGGER refuse_grant BEFORE UPDATE OF "status" ON "KnightsShopPurchase"
        FOR EACH ROW WHEN (NEW."status" = 'granted') EXECUTE FUNCTION refuse_grant();`);
    try {
      await expect(buy('buzz-50', { deps: defaultDeps({ buzz: buzz.port }) })).rejects.toThrow();
      expect((await pg.query(`SELECT "status" FROM "KnightsGoldConversion"`)).rows).toEqual([
        { status: 'pending' },
      ]);
    } finally {
      await pg.exec(
        `DROP TRIGGER refuse_grant ON "KnightsShopPurchase"; DROP FUNCTION refuse_grant();`
      );
    }

    await retryPendingConversions(db, buzz.port, { now: new Date(NOW.getTime() + 5 * 60_000) });
    expect((await purchases())[0].status).toBe('granted');
    expect(buzz.paid.size).toBe(1);
  });

  it('is granted when its conversion is marked paid, wherever that happens', async () => {
    await buy('buzz-50', { deps: defaultDeps({ buzz: fakeBuzz({ failFirst: true }).port }) });
    const [purchase] = await purchases();

    await markConversionPaid(db, purchase.conversionId as number, 'tx-elsewhere', NOW);

    expect((await purchases())[0].status).toBe('granted');
  });
});

describe('cosmetics', () => {
  it('grants a badge keyed by the purchase and refreshes the main app caches', async () => {
    const mainApp = fakeMainApp();
    const result = await buy('badge-seal', { deps: defaultDeps({ mainApp: mainApp.port }) });

    expect(result).toMatchObject({ status: 'granted' });
    const [purchase] = await purchases();
    const owned = (await pg.query(`SELECT * FROM "UserCosmetic" WHERE "userId"=1`)).rows as Record<
      string,
      unknown
    >[];
    expect(owned).toEqual([
      expect.objectContaining({ cosmeticId: 101, claimKey: purchase.externalKey, remaining: null }),
    ]);
    expect(mainApp.refreshCosmetics).toHaveBeenCalledWith(1);
    expect(await player()).toMatchObject({ goldConverted: 400 });
  });

  it('still grants when the cache refresh fails', async () => {
    const mainApp = fakeMainApp();
    mainApp.refreshCosmetics.mockRejectedValueOnce(new Error('down'));
    expect(await buy('badge-seal', { deps: defaultDeps({ mainApp: mainApp.port }) })).toMatchObject(
      { status: 'granted' }
    );
  });

  it('sells a badge once', async () => {
    await buy('badge-seal');
    expect(await buy('badge-seal')).toEqual({ status: 'refused', reason: 'owned' });
    expect(await player()).toMatchObject({ goldConverted: 400 });
  });

  it('refuses a badge the player already has from elsewhere', async () => {
    await pg.query(`INSERT INTO "UserCosmetic" ("userId","cosmeticId") VALUES (1,101)`);
    expect(await buy('badge-seal')).toEqual({ status: 'refused', reason: 'owned' });
  });

  it('adds uses when a sticker is bought again', async () => {
    await buy('sticker-wave');
    await buy('sticker-wave');

    const { rows } = await pg.query<{ total: number; n: number }>(
      `SELECT sum("remaining")::int AS total, count(*)::int AS n FROM "UserCosmetic" WHERE "userId"=1 AND "cosmeticId"=102`
    );
    expect(rows[0]).toEqual({ total: 10, n: 2 });
    expect(await player()).toMatchObject({ goldConverted: 600 });
  });

  it('will not sell more of a sticker that is already unlimited', async () => {
    await buy('sticker-free');
    expect(await buy('sticker-free')).toEqual({ status: 'refused', reason: 'unlimited' });
  });
});

describe('a membership month', () => {
  it('is granted once through the main app under the purchase key', async () => {
    const mainApp = fakeMainApp();
    const result = await buy('member-silver', { deps: defaultDeps({ mainApp: mainApp.port }) });

    expect(result).toMatchObject({ status: 'granted' });
    const [purchase] = await purchases();
    expect(mainApp.grantMembership).toHaveBeenCalledTimes(1);
    expect(mainApp.grantMembership).toHaveBeenCalledWith({
      userId: 1,
      tier: 'silver',
      key: purchase.externalKey,
    });
    expect(await player()).toMatchObject({ goldConverted: 12_000 });
  });

  it('stays pending when the main app does not answer, and the tick grants it once with the same key', async () => {
    const mainApp = fakeMainApp({ failFirst: true });
    expect(
      await buy('member-silver', { deps: defaultDeps({ mainApp: mainApp.port }) })
    ).toMatchObject({ status: 'pending' });
    expect((await getGoldBalance(db, 1)).onItsWay).toBe(12_000);

    const later = new Date(NOW.getTime() + 5 * 60_000);
    expect(await retryPendingPurchases(db, mainApp.port, { now: later })).toMatchObject({
      retried: 1,
      granted: 1,
    });
    expect(await retryPendingPurchases(db, mainApp.port, { now: later })).toMatchObject({
      retried: 0,
    });

    expect((await purchases())[0].status).toBe('granted');
    expect(mainApp.memberships.size).toBe(1);
    expect(mainApp.grantMembership.mock.calls[0][0].key).toBe(
      mainApp.grantMembership.mock.calls[1][0].key
    );
  });

  it('is refused up front, with the gold untouched, when the player already has a membership', async () => {
    await pg.exec(`
      INSERT INTO "Product" ("id","metadata") VALUES ('p-bronze', '{"tier":"bronze"}');
      INSERT INTO "CustomerSubscription" ("id","userId","productId","status","currentPeriodEnd")
        VALUES ('s1', 1, 'p-bronze', 'active', '2027-01-20');`);
    const mainApp = fakeMainApp();

    const result = await buy('member-silver', { deps: defaultDeps({ mainApp: mainApp.port }) });

    expect(result).toEqual({ status: 'refused', reason: 'has-membership' });
    expect(mainApp.grantMembership).not.toHaveBeenCalled();
    expect(await player()).toMatchObject({ goldConverted: 0 });
    expect(await purchases()).toHaveLength(0);
  });

  it('is not held back by a membership that has ended or been cancelled', async () => {
    await pg.exec(`
      INSERT INTO "Product" ("id","metadata") VALUES ('p-bronze', '{"tier":"bronze"}');
      INSERT INTO "CustomerSubscription" ("id","userId","productId","status","currentPeriodEnd") VALUES
        ('s1', 1, 'p-bronze', 'active', '2026-11-20'),
        ('s2', 1, 'p-bronze', 'canceled', '2027-01-20');`);

    expect(await buy('member-silver')).toMatchObject({ status: 'granted' });
  });

  it('replays the original answer for the same key even after the membership is active', async () => {
    const mainApp = fakeMainApp();
    const first = await buy('member-silver', {
      key: 'member-replay',
      deps: defaultDeps({ mainApp: mainApp.port }),
    });
    await pg.exec(`
      INSERT INTO "Product" ("id","metadata") VALUES ('p-silver', '{"tier":"silver"}');
      INSERT INTO "CustomerSubscription" ("id","userId","productId","status","currentPeriodEnd")
        VALUES ('s1', 1, 'p-silver', 'active', '2027-01-20');`);

    const again = await buy('member-silver', { key: 'member-replay' });

    expect(again).toMatchObject({
      status: 'granted',
      replayed: true,
      purchaseId: (first as { purchaseId: number }).purchaseId,
    });
    expect(mainApp.grantMembership).toHaveBeenCalledTimes(1);
  });

  it('reports a replayed pending membership as a replay', async () => {
    const down = fakeMainApp({ down: true });
    await buy('member-silver', {
      key: 'pending-replay',
      deps: defaultDeps({ mainApp: down.port }),
    });

    const again = await buy('member-silver', {
      key: 'pending-replay',
      deps: defaultDeps({ mainApp: down.port }),
    });

    expect(again).toMatchObject({ status: 'pending', replayed: true });
  });

  it('is sold one month at a time: an item that says otherwise is not on sale', async () => {
    await pg.query(`UPDATE "KnightsShopItem" SET "months" = 3 WHERE "id" = 'member-silver'`);
    expect(await buy('member-silver')).toEqual({ status: 'refused', reason: 'unknown-item' });
  });

  it('gives the gold back when the main app refuses it for good', async () => {
    const mainApp = fakeMainApp({ reject: 409 });
    const result = await buy('member-silver', { deps: defaultDeps({ mainApp: mainApp.port }) });

    expect(result).toMatchObject({ status: 'failed', forfeited: false });
    expect((await purchases())[0].status).toBe('failed');
    expect(await player()).toMatchObject({ goldConverted: 0 });
  });

  it('forfeits a reservation made before a career reset when it is refused later', async () => {
    const mainApp = fakeMainApp({ failFirst: true });
    await buy('member-silver', { deps: defaultDeps({ mainApp: mainApp.port }) });
    await pg.query(
      `UPDATE "NewOrderPlayer" SET "goldEarned" = "goldConverted", "startAt" = clock_timestamp() + interval '1 second' WHERE "userId"=1`
    );

    await retryPendingPurchases(db, fakeMainApp({ reject: 409 }).port, {
      now: new Date(NOW.getTime() + 5 * 60_000),
    });

    expect(await player()).toMatchObject({ goldEarned: 0, goldConverted: 0 });
  });

  it("leaves a held player's pending purchase alone until the hold clears", async () => {
    const mainApp = fakeMainApp({ failFirst: true });
    await buy('member-silver', { deps: defaultDeps({ mainApp: mainApp.port }) });
    await pg.query(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt" = now() WHERE "userId"=1`);

    expect(
      await retryPendingPurchases(db, mainApp.port, { now: new Date(NOW.getTime() + 5 * 60_000) })
    ).toMatchObject({ retried: 0 });
  });
});
