import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedPlayer, setGold } from '../../../test/seed';
import { getGoldBalance } from './balance';
import type { BuzzGrant, BuzzPort } from './buzz';
import { convertGold, retryPendingConversions } from './convert';

const NOW = new Date('2026-12-20T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;

/** Buzz as the service behaves: one transaction per external id, however often it is asked. */
function fakeBuzz({ failFirst = false, lostAnswer = false } = {}) {
  const paid = new Map<string, { userId: number; amount: number; transactionId: string }>();
  let calls = 0;
  const grantYellow = vi.fn<BuzzPort['grantYellow']>(async (grant: BuzzGrant) => {
    calls++;
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
      held: false,
      buzzOnConvert: 10,
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

    // the player pressing Convert again resumes the same conversion; it does not start a second
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

    expect(retried).toEqual({ retried: 1, paid: 1 });
    expect(buzz.paid.size).toBe(1);
    expect(await conversions()).toEqual([expect.objectContaining({ status: 'paid' })]);
  });
});

describe('retryPendingConversions', () => {
  it('leaves a recent attempt alone, and a held player pending until released', async () => {
    const buzz = fakeBuzz({ failFirst: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 10_000, cleared: 10_000 });
    await convertGold(db, buzz.port, { playerId: 1, now: NOW });
    const later = new Date(Date.now() + 3_600_000);

    expect(await retryPendingConversions(db, buzz.port, { now: new Date(0) })).toEqual({
      retried: 0,
      paid: 0,
    });
    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"='2026-12-19' WHERE "userId"=1`);
    expect(await retryPendingConversions(db, buzz.port, { now: later })).toEqual({
      retried: 0,
      paid: 0,
    });
    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"=NULL WHERE "userId"=1`);
    expect(await retryPendingConversions(db, buzz.port, { now: later })).toEqual({
      retried: 1,
      paid: 1,
    });
  });
});
