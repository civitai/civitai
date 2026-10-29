import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedPlayer, setGold } from '../../../test/seed';
import { getGoldBalance } from './balance';
import type { BuzzGrant, BuzzPort } from './buzz';
import { BuzzRejectedError } from './buzz';
import { convertGold, markConversionPaid, retryPendingConversions } from './convert';

const NOW = new Date('2026-12-20T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;

/** Buzz as the service behaves: one transaction per external id, however often it is asked. */
function fakeBuzz({ failFirst = false, lostAnswer = false, reject = false } = {}) {
  const paid = new Map<string, { userId: number; amount: number; transactionId: string }>();
  let calls = 0;
  const grantYellow = vi.fn<BuzzPort['grantYellow']>(async (grant: BuzzGrant) => {
    calls++;
    if (reject) throw new BuzzRejectedError(400);
    if (failFirst && calls === 1) throw new Error('buzz down');
    const existing = paid.get(grant.externalTransactionId);
    if (!existing) {
      paid.set(grant.externalTransactionId, {
        userId: grant.userId,
        amount: grant.amount,
        transactionId: `tx-${paid.size + 1}`,
      });
    }
    if (lostAnswer && calls === 1) throw new Error('timed out');
    return {
      transactionId: existing ? null : paid.get(grant.externalTransactionId)!.transactionId,
    };
  });
  return { port: { grantYellow } as BuzzPort, grantYellow, paid };
}

const row = async (userId: number) =>
  (
    await pg.query<{ goldConverted: number }>(
      `SELECT "goldConverted" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [userId]
    )
  ).rows[0];
const conversions = async () =>
  (await pg.query<Record<string, unknown>>(`SELECT * FROM "KnightsGoldConversion" ORDER BY id`))
    .rows;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE "KnightsGoldConversion", "NewOrderPlayer", "User" RESTART IDENTITY`);
});

describe('gold balance', () => {
  it('shows pending, awaiting detection, convertible and converted apart', async () => {
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { pending: 300, earned: 15_000, cleared: 12_000, converted: 2_000 });

    expect(await getGoldBalance(db, 1)).toMatchObject({
      pending: 300,
      awaitingDetection: 3_000,
      convertible: 10_000,
      frozen: 0,
      converted: 2_000,
      onItsWay: 0,
      held: false,
      buzzOnConvert: 10,
    });
  });

  it('counts a reservation Buzz has not confirmed as on its way, not converted, held or not', async () => {
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 20_000, cleared: 20_000, converted: 7_000 });
    await pg.exec(
      `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId") VALUES (1,5000,5,'pending','k1')`
    );

    expect(await getGoldBalance(db, 1)).toMatchObject({
      converted: 2_000,
      onItsWay: 5_000,
      convertible: 13_000,
      awaitingDetection: 0,
    });

    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"='2026-12-19' WHERE "userId"=1`);
    expect(await getGoldBalance(db, 1)).toMatchObject({
      converted: 2_000,
      onItsWay: 5_000,
      convertible: 0,
      frozen: 13_000,
    });
  });

  it('freezes every earned, unconverted gold of a held player and makes none convertible', async () => {
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 15_000, cleared: 12_000, converted: 2_000 });
    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"='2026-12-19' WHERE "userId"=1`);

    expect(await getGoldBalance(db, 1)).toMatchObject({
      awaitingDetection: 0,
      convertible: 0,
      frozen: 13_000,
      held: true,
      buzzOnConvert: 0,
    });
  });

  it('treats a banned account as held', async () => {
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 9_000, cleared: 9_000 });
    await pg.exec(`INSERT INTO "User" ("id","bannedAt") VALUES (1,'2026-12-01')`);

    expect(await getGoldBalance(db, 1)).toMatchObject({ convertible: 0, frozen: 9_000 });
  });

  it('is empty for someone who never played', async () => {
    expect(await getGoldBalance(db, 99)).toMatchObject({ convertible: 0, frozen: 0, pending: 0 });
  });
});

describe('convertGold', () => {
  it('pays the whole Buzz in the convertible gold and records the transaction', async () => {
    const buzz = fakeBuzz();
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 13_000, cleared: 12_500 });

    const result = await convertGold(db, buzz.port, { playerId: 1, now: NOW });

    expect(result).toEqual({ status: 'converted', gold: 12_000, buzz: 12, transactionId: 'tx-1' });
    expect(buzz.grantYellow).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, amount: 12 })
    );
    expect(await row(1)).toEqual({ goldConverted: 12_000 });
    expect(await conversions()).toEqual([
      expect.objectContaining({
        playerId: 1,
        gold: 12_000,
        buzz: 12,
        status: 'paid',
        buzzTransactionId: 'tx-1',
      }),
    ]);
    expect(await getGoldBalance(db, 1)).toMatchObject({ convertible: 500, awaitingDetection: 500 });
  });

  it('refuses below the minimum and asks Buzz for nothing', async () => {
    const buzz = fakeBuzz();
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 4_999, cleared: 4_999 });

    expect(await convertGold(db, buzz.port, { playerId: 1, now: NOW })).toEqual({
      status: 'refused',
      reason: 'below-minimum',
    });
    expect(buzz.grantYellow).not.toHaveBeenCalled();
    expect(await conversions()).toEqual([]);
  });

  it('converts nothing for gold no detection run has cleared', async () => {
    const buzz = fakeBuzz();
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 50_000, cleared: 0 });

    expect(await convertGold(db, buzz.port, { playerId: 1, now: NOW })).toMatchObject({
      status: 'refused',
    });
    expect(buzz.grantYellow).not.toHaveBeenCalled();
  });

  it('refuses a held player whose gold is cleared, and keeps the gold for when they are released', async () => {
    const buzz = fakeBuzz();
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 20_000, cleared: 20_000 });
    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"='2026-12-19' WHERE "userId"=1`);

    expect(await convertGold(db, buzz.port, { playerId: 1, now: NOW })).toEqual({
      status: 'refused',
      reason: 'held',
    });
    expect(buzz.grantYellow).not.toHaveBeenCalled();

    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"=NULL WHERE "userId"=1`);
    expect(await convertGold(db, buzz.port, { playerId: 1, now: NOW })).toMatchObject({
      status: 'converted',
      buzz: 20,
    });
  });

  it('refuses a player with no row', async () => {
    expect(await convertGold(db, fakeBuzz().port, { playerId: 5, now: NOW })).toEqual({
      status: 'refused',
      reason: 'no-player',
    });
  });

  it('pays once when the same conversion is submitted again', async () => {
    const buzz = fakeBuzz();
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });

    await convertGold(db, buzz.port, { playerId: 1, now: NOW });
    const again = await convertGold(db, buzz.port, { playerId: 1, now: NOW });

    expect(again).toEqual({ status: 'refused', reason: 'below-minimum' });
    expect(buzz.paid.size).toBe(1);
    expect(await row(1)).toEqual({ goldConverted: 10_000 });
  });

  it('keeps the gold reserved when Buzz fails, and a retry pays it once with the same key', async () => {
    const buzz = fakeBuzz({ failFirst: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });

    expect(await convertGold(db, buzz.port, { playerId: 1, now: NOW })).toEqual({
      status: 'pending',
      gold: 10_000,
      buzz: 10,
    });
    expect(buzz.paid.size).toBe(0);
    const [pending] = await conversions();
    expect(pending).toMatchObject({ status: 'pending', gold: 10_000, buzzTransactionId: null });

    expect(await convertGold(db, buzz.port, { playerId: 1, now: NOW })).toMatchObject({
      status: 'converted',
      buzz: 10,
    });
    expect(buzz.paid.size).toBe(1);
    expect(await conversions()).toHaveLength(1);
    expect(buzz.grantYellow.mock.calls[0][0].externalTransactionId).toBe(
      buzz.grantYellow.mock.calls[1][0].externalTransactionId
    );
    expect(await row(1)).toEqual({ goldConverted: 10_000 });
  });

  it('pays once when Buzz paid but its answer was lost', async () => {
    const buzz = fakeBuzz({ lostAnswer: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });

    expect(await convertGold(db, buzz.port, { playerId: 1, now: NOW })).toMatchObject({
      status: 'pending',
    });
    const retried = await retryPendingConversions(db, buzz.port, {
      now: new Date(NOW.getTime() + 120_000),
    });

    expect(retried).toEqual({ retried: 1, paid: 1, failed: 0 });
    expect(buzz.paid.size).toBe(1);
    expect(await conversions()).toEqual([expect.objectContaining({ status: 'paid' })]);
  });
});

describe('a definitive Buzz rejection', () => {
  it('fails the conversion, gives the gold back and logs it', async () => {
    const buzz = fakeBuzz({ reject: true });
    const log = vi.fn();
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });

    expect(await convertGold(db, buzz.port, { playerId: 1, now: NOW, log })).toEqual({
      status: 'failed',
      gold: 10_000,
      buzz: 10,
      forfeited: false,
    });

    expect(await row(1)).toEqual({ goldConverted: 0 });
    expect(await conversions()).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(await getGoldBalance(db, 1)).toMatchObject({ convertible: 10_000, onItsWay: 0 });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'knights-gold-conversion-rejected' })
    );
  });

  it('does not block the next conversion', async () => {
    const buzz = fakeBuzz({ reject: true });
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });
    await convertGold(db, buzz.port, { playerId: 1, now: NOW });

    const next = await convertGold(db, fakeBuzz().port, { playerId: 1, now: NOW });

    expect(next).toMatchObject({ status: 'converted', buzz: 10 });
    expect(await row(1)).toEqual({ goldConverted: 10_000 });
  });

  it('is released by the tick retry too, once', async () => {
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });
    await convertGold(db, fakeBuzz({ failFirst: true }).port, { playerId: 1, now: NOW });
    const later = new Date(NOW.getTime() + 3_600_000);

    expect(
      await retryPendingConversions(db, fakeBuzz({ reject: true }).port, { now: later })
    ).toEqual({
      retried: 1,
      paid: 0,
      failed: 1,
    });
    expect(
      await retryPendingConversions(db, fakeBuzz({ reject: true }).port, { now: later })
    ).toEqual({
      retried: 0,
      paid: 0,
      failed: 0,
    });
    expect(await row(1)).toEqual({ goldConverted: 0 });
  });

  it('leaves an unknown outcome pending and logs a warning', async () => {
    const log = vi.fn();
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });

    const result = await convertGold(db, fakeBuzz({ failFirst: true }).port, {
      playerId: 1,
      now: NOW,
      log,
    });

    expect(result.status).toBe('pending');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'knights-gold-conversion-unconfirmed' })
    );
  });
});

describe('a career reset', () => {
  // mirrors the statement resetPlayer runs in the main app
  const reset = (userId: number) =>
    pg.exec(`
      UPDATE "NewOrderPlayer" SET "startAt" = '2026-12-25', "goldPending" = 0,
        "goldEarned" = "goldConverted", "goldCleared" = "goldConverted" WHERE "userId" = ${userId}`);
  const gold = async (userId: number) =>
    (
      await pg.query(
        `SELECT "goldPending","goldEarned","goldCleared","goldConverted" FROM "NewOrderPlayer" WHERE "userId"=$1`,
        [userId]
      )
    ).rows[0];

  it('forfeits unconverted gold, keeps what was paid, and lets a reserved conversion finish', async () => {
    const buzz = fakeBuzz();
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { pending: 400, earned: 30_000, cleared: 25_000, converted: 10_000 });
    await pg.exec(
      `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId") VALUES (1,10000,10,'pending','k1')`
    );

    await reset(1);

    expect(await gold(1)).toEqual({
      goldPending: 0,
      goldEarned: 10_000,
      goldCleared: 10_000,
      goldConverted: 10_000,
    });
    expect(await getGoldBalance(db, 1)).toMatchObject({ convertible: 0, awaitingDetection: 0 });
    expect(
      await retryPendingConversions(db, buzz.port, { now: new Date(NOW.getTime() + 3_600_000) })
    ).toMatchObject({ retried: 1, paid: 1 });
    expect(await gold(1)).toMatchObject({ goldEarned: 10_000, goldConverted: 10_000 });
    expect(await conversions()).toEqual([expect.objectContaining({ status: 'paid' })]);
  });

  it.each([
    ['one millisecond before the reset', '2026-12-24 23:59:59.999', true],
    ['at the moment of the reset', '2026-12-25 00:00:00.000', false],
    ['after the reset', '2026-12-25 00:00:00.001', false],
  ])(
    'decides a conversion made %s by its ordering with startAt',
    async (_when, createdAt, forfeits) => {
      await seedPlayer(pg, 1);
      await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });
      await convertGold(db, fakeBuzz({ failFirst: true }).port, { playerId: 1, now: NOW });
      await pg.query(`UPDATE "KnightsGoldConversion" SET "createdAt" = $1::timestamp`, [createdAt]);
      await reset(1);

      const result = await retryPendingConversions(db, fakeBuzz({ reject: true }).port, {
        now: new Date('2027-01-01'),
      });

      expect(result.failed).toBe(1);
      expect(await gold(1)).toMatchObject({ goldEarned: forfeits ? 0 : 10_000 });
    }
  );

  it('reports a forfeited refusal to the player', async () => {
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });
    await convertGold(db, fakeBuzz({ failFirst: true }).port, { playerId: 1, now: NOW });
    await pg.exec(`UPDATE "KnightsGoldConversion" SET "createdAt" = '2026-12-24'`);
    await reset(1);

    expect(
      await convertGold(db, fakeBuzz({ reject: true }).port, { playerId: 1, now: NOW })
    ).toMatchObject({
      status: 'failed',
      forfeited: true,
    });
  });

  it('does not give back a before-reset conversion that Buzz later refuses', async () => {
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });
    await convertGold(db, fakeBuzz({ failFirst: true }).port, { playerId: 1, now: NOW });
    await pg.exec(`UPDATE "KnightsGoldConversion" SET "createdAt" = '2026-12-24'`);
    await reset(1);

    await retryPendingConversions(db, fakeBuzz({ reject: true }).port, {
      now: new Date('2027-01-01'),
    });

    expect(await gold(1)).toEqual({
      goldPending: 0,
      goldEarned: 0,
      goldCleared: 0,
      goldConverted: 0,
    });
    expect(await conversions()).toEqual([expect.objectContaining({ status: 'failed' })]);
  });
});

describe('markConversionPaid', () => {
  it('never overwrites a stored Buzz transaction id, and fills in a missing one', async () => {
    await pg.exec(
      `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId") VALUES (1,5000,5,'pending','k1')`
    );

    await markConversionPaid(db, 1, null, NOW);
    expect(await conversions()).toEqual([
      expect.objectContaining({ status: 'paid', buzzTransactionId: null }),
    ]);
    await markConversionPaid(db, 1, 'tx-real', NOW);
    await markConversionPaid(db, 1, null, NOW);
    await markConversionPaid(db, 1, 'tx-other', NOW);

    expect(await conversions()).toEqual([
      expect.objectContaining({ status: 'paid', buzzTransactionId: 'tx-real' }),
    ]);
  });
});

describe('retryPendingConversions', () => {
  it('retries a conversion only once it is a minute old', async () => {
    const buzz = fakeBuzz();
    await pg.exec(
      `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId","createdAt") VALUES (1,5000,5,'pending','k1','2026-12-20 12:00:00')`
    );
    await seedPlayer(pg, 1);

    const at = (seconds: number) => new Date(Date.UTC(2026, 11, 20, 12, 0, seconds));
    expect(await retryPendingConversions(db, buzz.port, { now: at(59) })).toMatchObject({
      retried: 0,
    });
    expect(await retryPendingConversions(db, buzz.port, { now: at(60) })).toMatchObject({
      retried: 1,
      paid: 1,
    });
  });

  it('goes on to the next conversion when one cannot be settled', async () => {
    const log = vi.fn();
    await seedPlayer(pg, 1);
    for (const key of ['k1', 'k2'])
      await pg.exec(
        `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId","createdAt") VALUES (1,5000,5,'pending','${key}','2026-12-20 12:00:00')`
      );
    await pg.exec(
      `CREATE OR REPLACE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql;
       CREATE TRIGGER boom BEFORE UPDATE ON "KnightsGoldConversion" FOR EACH ROW WHEN (OLD."externalTransactionId" = 'k1') EXECUTE FUNCTION boom()`
    );

    const result = await retryPendingConversions(db, fakeBuzz().port, {
      now: new Date(Date.UTC(2026, 11, 20, 13)),
      log,
    });
    await pg.exec(`DROP TRIGGER boom ON "KnightsGoldConversion"`);

    expect(result).toEqual({ retried: 2, paid: 1, failed: 0 });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'knights-gold-conversion-retry-error' })
    );
  });

  it('lets the conversions behind a stuck one progress', async () => {
    const stuck: BuzzPort = {
      grantYellow: vi.fn(async (g: BuzzGrant) => {
        if (g.externalTransactionId === 'k1') throw new Error('buzz down');
        return { transactionId: 'tx' };
      }),
    };
    await seedPlayer(pg, 1);
    for (const key of ['k1', 'k2', 'k3'])
      await pg.exec(
        `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId","createdAt") VALUES (1,5000,5,'pending','${key}','2026-12-20 12:00:00')`
      );
    const at = new Date(Date.UTC(2026, 11, 20, 13));

    await retryPendingConversions(db, stuck, { now: at, limit: 1 });
    await retryPendingConversions(db, stuck, { now: at, limit: 1 });
    await retryPendingConversions(db, stuck, { now: at, limit: 1 });

    expect(
      (
        await pg.query(
          `SELECT "externalTransactionId" FROM "KnightsGoldConversion" WHERE status='paid' ORDER BY id`
        )
      ).rows
    ).toEqual([{ externalTransactionId: 'k2' }, { externalTransactionId: 'k3' }]);
    const later = new Date(at.getTime() + 61_000);
    expect(await retryPendingConversions(db, stuck, { now: later, limit: 1 })).toMatchObject({
      retried: 1,
      paid: 0,
    });
  });

  it('starts no retry that could not finish inside the budget', async () => {
    await seedPlayer(pg, 1);
    await pg.exec(
      `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId","createdAt") VALUES (1,5000,5,'pending','k1','2026-12-20 12:00:00')`
    );
    const now = new Date(Date.UTC(2026, 11, 20, 13));

    expect(
      await retryPendingConversions(db, fakeBuzz().port, {
        now,
        budgetMs: 10_000,
        attemptMs: 15_000,
      })
    ).toMatchObject({ retried: 0 });
    expect(
      await retryPendingConversions(db, fakeBuzz().port, {
        now,
        budgetMs: 20_000,
        attemptMs: 15_000,
      })
    ).toMatchObject({ retried: 1 });
  });

  it('stops at the limit and when its time budget is spent', async () => {
    const buzz = fakeBuzz();
    await seedPlayer(pg, 1);
    for (const key of ['k1', 'k2', 'k3'])
      await pg.exec(
        `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId","createdAt") VALUES (1,5000,5,'pending','${key}','2026-12-20 12:00:00')`
      );
    const later = new Date(Date.UTC(2026, 11, 20, 13));

    expect(await retryPendingConversions(db, buzz.port, { now: later, budgetMs: 0 })).toMatchObject(
      { retried: 0 }
    );
    expect(await retryPendingConversions(db, buzz.port, { now: later, limit: 2 })).toMatchObject({
      retried: 2,
      paid: 2,
    });
    expect(await retryPendingConversions(db, buzz.port, { now: later, limit: 2 })).toMatchObject({
      retried: 1,
      paid: 1,
    });
  });

  it('leaves a recent attempt alone, and a held player pending until released', async () => {
    const buzz = fakeBuzz({ failFirst: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });
    await convertGold(db, buzz.port, { playerId: 1, now: NOW });
    const later = new Date(NOW.getTime() + 3_600_000);

    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"='2026-12-19' WHERE "userId"=1`);
    expect(await retryPendingConversions(db, buzz.port, { now: later })).toEqual({
      retried: 0,
      paid: 0,
      failed: 0,
    });
    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"=NULL WHERE "userId"=1`);
    expect(await retryPendingConversions(db, buzz.port, { now: later })).toEqual({
      retried: 1,
      paid: 1,
      failed: 0,
    });
  });
});
