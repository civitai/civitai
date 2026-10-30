import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { PROGRESSION } from '../progression/config';
import {
  castVote,
  enqueueItem,
  ensureVotePartitions,
  type QueueDeps,
} from '../queue/queue.service';
import { RANK_RULES } from '../ranks';
import { DAILY } from './config';
import { dismissRecap, getDailyStatus, getRecap, recordVoteDay } from './daily.service';

const Q = 'knights.image.nsfwLevel';
const NOON = (day: string) => new Date(`${day}T12:00:00Z`);
const D1 = '2026-12-14';
const D2 = '2026-12-15';
const D3 = '2026-12-16';
const D4 = '2026-12-17';

let pg: PGlite;
let db: Kysely<DB>;
let imageId = 1000;
const applyConsensus = vi.fn<QueueDeps['applyConsensus']>(async () => ({ outcome: 'applied' }));

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOON(D1), monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post","KnightsPlayer","KnightsPlayerDay" RESTART IDENTITY`
  );
});

async function voteOnFreshItem(userId: number, at: Date, votesNeeded?: number) {
  const id = ++imageId;
  await seedImage(pg, id);
  const itemId = await enqueueItem(
    db,
    { questionKey: Q, imageId: id, source: 'test', expiresAt: null, votesNeeded },
    at
  );
  return castVote(db, { userId, itemId, answer: '4' }, { applyConsensus, now: () => at });
}

/** Skips the first `votes` votes of a day, so a test can reach the Watch or the cap in one real vote. */
const seedDay = (
  userId: number,
  day: string,
  over: { votes?: number; goldRecorded?: number } = {}
) =>
  pg.query(
    `INSERT INTO "KnightsPlayerDay" ("playerId","day","votes","goldRecorded") VALUES ($1,$2,$3,$4)
     ON CONFLICT ("playerId","day") DO UPDATE SET "votes"=$3,"goldRecorded"=$4`,
    [userId, day, over.votes ?? 0, over.goldRecorded ?? 0]
  );

async function completeWatchOn(userId: number, day: string) {
  await seedDay(userId, day, { votes: DAILY.watchSize - 1 });
  await voteOnFreshItem(userId, NOON(day));
}

const dayRow = async (userId: number, day: string) =>
  (
    await pg.query<{
      votes: number;
      goldRecorded: number;
      watchCompletedAt: Date | null;
      bonusGold: number;
    }>(
      `SELECT votes,"goldRecorded","watchCompletedAt","bonusGold" FROM "KnightsPlayerDay" WHERE "playerId"=$1 AND day=$2`,
      [userId, day]
    )
  ).rows[0];

const keeper = async (userId: number) =>
  (
    await pg.query<{
      streak: number;
      lastWatchDay: string | null;
      shields: number;
      shieldWeek: string;
    }>(
      `SELECT streak,"lastWatchDay"::text,shields,"shieldWeek"::text FROM "KnightsPlayer" WHERE "playerId"=$1`,
      [userId]
    )
  ).rows[0];

const wallet = async (userId: number) =>
  (
    await pg.query<{ exp: number; goldPending: number; goldEarned: number }>(
      `SELECT exp,"goldPending","goldEarned" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [userId]
    )
  ).rows[0];

const cap = RANK_RULES.Knight.dailyGoldCap;

describe('the day row', () => {
  it('counts each vote and the gold recorded for it', async () => {
    await seedPlayer(pg, 1);
    await voteOnFreshItem(1, NOON(D1));
    await voteOnFreshItem(1, NOON(D1));

    expect(await dayRow(1, D1)).toMatchObject({
      votes: 2,
      goldRecorded: 2 * PROGRESSION.baseGold,
      watchCompletedAt: null,
    });
  });

  it('starts a new row on the next UTC day, split at midnight', async () => {
    await seedPlayer(pg, 1);
    await voteOnFreshItem(1, new Date(`${D1}T23:59:59Z`));
    await voteOnFreshItem(1, new Date(`${D2}T00:00:00Z`));

    expect((await dayRow(1, D1)).votes).toBe(1);
    expect((await dayRow(1, D2)).votes).toBe(1);
  });

  it('does not count a refused vote', async () => {
    await seedPlayer(pg, 1);
    const refused = await castVote(
      db,
      { userId: 1, itemId: 999, answer: '4' },
      { applyConsensus, now: () => NOON(D1) }
    );
    expect(refused.status).toBe('rejected');
    expect(await dayRow(1, D1)).toBeUndefined();
  });
});

describe('the daily gold cap', () => {
  it('records only what is left of the cap on the vote that crosses it', async () => {
    await seedPlayer(pg, 1);
    await seedDay(1, D1, { votes: 10, goldRecorded: cap - 60 });

    await voteOnFreshItem(1, NOON(D1));

    expect(await dayRow(1, D1)).toMatchObject({ goldRecorded: cap, votes: 11 });
    expect(await wallet(1)).toMatchObject({ goldPending: 60, exp: PROGRESSION.voteXp });
    const gold = await pg.query<{ gold: number }>(
      `SELECT gold FROM "KnightsVote" WHERE "playerId"=1`
    );
    expect(gold.rows[0].gold).toBe(60);
  });

  it('records no gold past the cap, but the vote still pays XP and counts toward the Watch', async () => {
    await seedPlayer(pg, 1);
    await seedDay(1, D1, { votes: 10, goldRecorded: cap });

    await voteOnFreshItem(1, NOON(D1));

    expect(await wallet(1)).toEqual({ exp: PROGRESSION.voteXp, goldPending: 0, goldEarned: 0 });
    expect(await dayRow(1, D1)).toMatchObject({ votes: 11, goldRecorded: cap });
  });

  it('caps by the player rank', async () => {
    await seedPlayer(pg, 1, 'Paladin');
    await seedDay(1, D1, { goldRecorded: RANK_RULES.Paladin.dailyGoldCap - 10 });
    await voteOnFreshItem(1, NOON(D1));
    expect((await wallet(1)).goldPending).toBe(10);
  });

  it('opens a fresh cap the next UTC day', async () => {
    await seedPlayer(pg, 1);
    await seedDay(1, D1, { goldRecorded: cap });
    await voteOnFreshItem(1, NOON(D2));
    expect((await wallet(1)).goldPending).toBe(PROGRESSION.baseGold);
  });
});

describe('the Daily Watch', () => {
  it('completes on the vote that reaches the watch size, and pays the streak bonus once', async () => {
    await seedPlayer(pg, 1);
    for (let i = 0; i < DAILY.watchSize - 1; i++) await voteOnFreshItem(1, NOON(D1));
    expect((await dayRow(1, D1)).watchCompletedAt).toBeNull();
    expect((await wallet(1)).goldEarned).toBe(0);

    await voteOnFreshItem(1, NOON(D1));
    expect(await dayRow(1, D1)).toMatchObject({
      votes: DAILY.watchSize,
      bonusGold: DAILY.watchBonusGold,
    });
    expect((await dayRow(1, D1)).watchCompletedAt).not.toBeNull();
    expect((await wallet(1)).goldEarned).toBe(DAILY.watchBonusGold);

    await voteOnFreshItem(1, NOON(D1));
    expect((await wallet(1)).goldEarned).toBe(DAILY.watchBonusGold);
    expect((await keeper(1)).streak).toBe(1);
  });

  it('pays the bonus even when the gold cap is already reached', async () => {
    await seedPlayer(pg, 1);
    await seedDay(1, D1, { votes: DAILY.watchSize - 1, goldRecorded: cap });

    await voteOnFreshItem(1, NOON(D1));

    expect(await wallet(1)).toMatchObject({ goldEarned: DAILY.watchBonusGold, goldPending: 0 });
    expect((await dayRow(1, D1)).goldRecorded).toBe(cap);
  });
});

describe('streaks and shields', () => {
  it('grows the streak and the bonus on consecutive days, up to the cap', async () => {
    await seedPlayer(pg, 1);
    let day = D1;
    for (let n = 1; n <= DAILY.streakCap + 1; n++) {
      await completeWatchOn(1, day);
      expect((await keeper(1)).streak).toBe(n);
      expect((await dayRow(1, day)).bonusGold).toBe(
        DAILY.watchBonusGold * Math.min(n, DAILY.streakCap)
      );
      day = new Date(NOON(day).getTime() + 86_400_000).toISOString().slice(0, 10);
    }
  });

  it('resets after a missed day when no shield is left', async () => {
    await seedPlayer(pg, 1);
    await completeWatchOn(1, D1);
    await pg.query(`UPDATE "KnightsPlayer" SET shields=0 WHERE "playerId"=1`);

    await completeWatchOn(1, D3);

    expect(await keeper(1)).toMatchObject({ streak: 1, lastWatchDay: D3 });
    expect((await dayRow(1, D3)).bonusGold).toBe(DAILY.watchBonusGold);
  });

  it('lets a shield cover one missed day, and spends it', async () => {
    await seedPlayer(pg, 1);
    await completeWatchOn(1, D1);
    expect((await keeper(1)).shields).toBe(DAILY.maxShields);

    await completeWatchOn(1, D3);

    expect(await keeper(1)).toMatchObject({ streak: 2, shields: 0 });
    expect((await dayRow(1, D3)).bonusGold).toBe(2 * DAILY.watchBonusGold);
  });

  it('grants a new shield with the next ISO week', async () => {
    await seedPlayer(pg, 1);
    await completeWatchOn(1, '2026-12-18'); // Friday
    await pg.query(`UPDATE "KnightsPlayer" SET shields=0 WHERE "playerId"=1`);

    await completeWatchOn(1, '2026-12-21'); // Monday: Saturday and Sunday missed

    expect((await keeper(1)).streak).toBe(1);
    expect((await keeper(1)).shields).toBe(DAILY.maxShields);

    await completeWatchOn(1, '2026-12-23'); // Tuesday missed, the week's shield covers it
    expect(await keeper(1)).toMatchObject({ streak: 2, shields: 0 });
  });

  it('does not stack a Watch completed twice on one day', async () => {
    await seedPlayer(pg, 1);
    await completeWatchOn(1, D1);
    await voteOnFreshItem(1, NOON(D1));
    expect((await keeper(1)).streak).toBe(1);
  });
});

const setStart = (userId: number, at: string) =>
  pg.query(`UPDATE "NewOrderPlayer" SET "startAt"=$2::timestamp WHERE "userId"=$1`, [userId, at]);

const setKeeper = (
  userId: number,
  o: { streak: number; lastWatchDay: string; shields?: number; shieldWeek?: string }
) =>
  pg.query(
    `INSERT INTO "KnightsPlayer" ("playerId","streak","lastWatchDay","shields","shieldWeek") VALUES ($1,$2,$3,$4,$5)`,
    [userId, o.streak, o.lastWatchDay, o.shields ?? 0, o.shieldWeek ?? '2026-12-14']
  );

const markWatch = (userId: number, day: string, at: string, bonus: number) =>
  pg.query(
    `INSERT INTO "KnightsPlayerDay" ("playerId","day","votes","watchCompletedAt","bonusGold") VALUES ($1,$2,30,$3,$4)
     ON CONFLICT ("playerId","day") DO UPDATE SET "watchCompletedAt"=$3,"bonusGold"=$4,"votes"=30`,
    [userId, day, at, bonus]
  );

describe('a rank the cap does not know', () => {
  it('records no gold and does not throw', async () => {
    await seedPlayer(pg, 1);
    const day = await db.transaction().execute((trx) =>
      recordVoteDay(trx, {
        playerId: 1,
        rank: 'Squire',
        gold: 100,
        now: NOON(D1),
        startAt: new Date(0),
      })
    );
    expect(day.gold).toBe(0);
    expect((await dayRow(1, D1)).votes).toBe(1);
  });
});

describe('settling votes whose gold the cap trimmed', () => {
  it('moves only the trimmed gold from pending to earned', async () => {
    await seedPlayer(pg, 1);
    await seedDay(1, D1, { goldRecorded: cap - 60 });

    await voteOnFreshItem(1, NOON(D1), 1);

    const vote = await pg.query<{ gold: number; verdict: string; settledAt: Date | null }>(
      `SELECT gold,verdict,"settledAt" FROM "KnightsVote" WHERE "playerId"=1`
    );
    expect(vote.rows[0]).toMatchObject({ gold: 60, verdict: 'correct' });
    expect(vote.rows[0].settledAt).not.toBeNull();
    expect(await wallet(1)).toEqual({
      exp: PROGRESSION.voteXp + PROGRESSION.correctXp,
      goldPending: 0,
      goldEarned: 60,
    });
  });

  it('settles a zero-gold vote with its XP and no gold', async () => {
    await seedPlayer(pg, 1);
    await seedDay(1, D1, { goldRecorded: cap });

    await voteOnFreshItem(1, NOON(D1), 1);

    expect(await wallet(1)).toEqual({
      exp: PROGRESSION.voteXp + PROGRESSION.correctXp,
      goldPending: 0,
      goldEarned: 0,
    });
  });

  it('keeps the bonus separate from the vote gold when the settling vote completes the Watch', async () => {
    await seedPlayer(pg, 1);
    await seedDay(1, D1, { votes: DAILY.watchSize - 1, goldRecorded: cap - 40 });

    await voteOnFreshItem(1, NOON(D1), 1);

    expect((await wallet(1)).goldEarned).toBe(40 + DAILY.watchBonusGold);
  });
});

describe('a career reset (startAt)', () => {
  it('counts only the votes cast after a reset made earlier the same day', async () => {
    await seedPlayer(pg, 1);
    await seedDay(1, D1, { votes: DAILY.watchSize - 1 });
    await setStart(1, `${D1} 12:00:00`);

    await voteOnFreshItem(1, new Date(`${D1}T13:00:00Z`));
    expect(await dayRow(1, D1)).toMatchObject({ votes: 1, watchCompletedAt: null, bonusGold: 0 });
    expect((await wallet(1)).goldEarned).toBe(0);

    for (let i = 1; i < DAILY.watchSize; i++) await voteOnFreshItem(1, new Date(`${D1}T13:00:00Z`));
    expect(await dayRow(1, D1)).toMatchObject({
      votes: DAILY.watchSize,
      bonusGold: DAILY.watchBonusGold,
    });
  });

  it('does not show the votes of before the reset as progress, nor a Watch finished before it', async () => {
    await seedPlayer(pg, 1);
    await markWatch(1, D1, `${D1} 08:00:00`, DAILY.watchBonusGold);
    await setStart(1, `${D1} 12:00:00`);
    await voteOnFreshItem(1, new Date(`${D1}T13:00:00Z`));

    expect(await getDailyStatus(db, { playerId: 1, rank: 'Knight', now: NOON(D1) })).toMatchObject({
      votes: 1,
      watchDone: false,
    });
  });

  it('ends a 7-day streak, keeps the shields, and starts again from 1', async () => {
    await seedPlayer(pg, 1);
    await setKeeper(1, { streak: 7, lastWatchDay: D1, shields: 1 });
    await setStart(1, `${D2} 00:00:00`);

    const at = () => getDailyStatus(db, { playerId: 1, rank: 'Knight', now: NOON(D2) });
    expect(await at()).toMatchObject({ streak: 0, shields: 1 });

    await completeWatchOn(1, D2);

    expect(await keeper(1)).toMatchObject({ streak: 1, shields: 1, lastWatchDay: D2 });
    expect((await dayRow(1, D2)).bonusGold).toBe(DAILY.watchBonusGold);
  });

  it('ends a streak whose last Watch was finished earlier on the day of the reset', async () => {
    await seedPlayer(pg, 1);
    await setKeeper(1, { streak: 3, lastWatchDay: D1 });
    await markWatch(1, D1, `${D1} 08:00:00`, 300);
    await setStart(1, `${D1} 12:00:00`);

    await completeWatchOn(1, D2);

    expect((await keeper(1)).streak).toBe(1);
  });

  it('keeps a streak whose last Watch was finished after the reset', async () => {
    await seedPlayer(pg, 1);
    await setKeeper(1, { streak: 3, lastWatchDay: D1 });
    await markWatch(1, D1, `${D1} 08:00:00`, 300);
    await setStart(1, `${D1} 06:00:00`);

    await completeWatchOn(1, D2);

    expect((await keeper(1)).streak).toBe(4);
  });

  it('leaves the gold cap counting the whole day', async () => {
    await seedPlayer(pg, 1);
    await seedDay(1, D1, { goldRecorded: cap });
    await setStart(1, `${D1} 12:00:00`);
    await voteOnFreshItem(1, new Date(`${D1}T13:00:00Z`));
    expect((await wallet(1)).goldPending).toBe(0);
  });
});

describe('getDailyStatus', () => {
  it('reports progress, the cap and the shield for today', async () => {
    await seedPlayer(pg, 1);
    await seedDay(1, D1, { votes: 12, goldRecorded: 1200 });
    await voteOnFreshItem(1, NOON(D1));

    const status = await getDailyStatus(db, { playerId: 1, rank: 'Knight', now: NOON(D1) });
    expect(status).toMatchObject({
      votes: 13,
      watchSize: DAILY.watchSize,
      watchDone: false,
      goldCap: cap,
      capReached: false,
      streak: 0,
      shields: DAILY.maxShields,
      maxShields: DAILY.maxShields,
    });
  });

  it('flags the cap as reached', async () => {
    await seedPlayer(pg, 1);
    await seedDay(1, D1, { goldRecorded: cap });
    expect(await getDailyStatus(db, { playerId: 1, rank: 'Knight', now: NOON(D1) })).toMatchObject({
      capReached: true,
    });
  });

  it('shows the live streak: kept by a shield, then lost', async () => {
    await seedPlayer(pg, 1);
    await completeWatchOn(1, D1);

    const at = (day: string) => getDailyStatus(db, { playerId: 1, rank: 'Knight', now: NOON(day) });
    expect((await at(D2)).streak).toBe(1);
    expect((await at(D3)).streak).toBe(1); // D2 missed, the shield will cover it
    expect((await at(D4)).streak).toBe(0); // two missed days
    expect((await at(D2)).shieldCoversToday).toBe(true);
    expect((await at(D3)).shieldCoversToday).toBe(false); // the shield is already spoken for
  });

  it('works for a player who has not voted yet', async () => {
    await seedPlayer(pg, 1);
    expect(await getDailyStatus(db, { playerId: 1, rank: 'Knight', now: NOON(D1) })).toMatchObject({
      votes: 0,
      streak: 0,
      shields: DAILY.maxShields,
      watchDone: false,
    });
  });
});

describe('the recap', () => {
  async function ledger(
    userId: number,
    day: string,
    rows: { correct?: number; failed?: number; pending?: number; goldEach?: number }
  ) {
    const insert = (
      verdict: string,
      settled: boolean,
      count: number,
      gold: number,
      offset: number
    ) =>
      pg.query(
        `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict","settledAt","xp","gold")
         SELECT $1 + n, $2, $3::timestamp + (n || ' minutes')::interval, 'knights.image.nsfwLevel', 0, 'Knight', '4', 1, $4, ${
           settled ? `$3::timestamp` : 'NULL'
         }, 0, $5
         FROM generate_series(1, $6::int) AS n`,
        [70000 + offset + userId * 1000, userId, `${day} 08:00:00`, verdict, gold, count]
      );
    const { correct = 0, failed = 0, pending = 0, goldEach = 100 } = rows;
    await insert('correct', true, correct, goldEach, 0);
    await insert('failed', true, failed, 0, 100);
    await insert('pending', false, pending, goldEach, 200);
    await seedDay(userId, day, { votes: correct + failed + pending });
  }

  it('summarises the last play day: confirmed of cast, accuracy among settled, gold, pending', async () => {
    await seedPlayer(pg, 1);
    await ledger(1, D1, { correct: 18, failed: 3, pending: 9 });

    expect(await getRecap(db, { playerId: 1, now: NOON(D2) })).toEqual({
      day: D1,
      when: 'yesterday',
      cast: 30,
      confirmed: 18,
      graded: 21,
      accuracy: 18 / 21,
      goldEarned: 1800,
      pending: 9,
      streakBonus: 0,
    });
  });

  it('counts the gold of yes/no answers that matched the majority, and leaves them out of the accuracy', async () => {
    await seedPlayer(pg, 1);
    await ledger(1, D1, { correct: 2 });
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict","settledAt","xp","gold")
       VALUES (1,1,$1::timestamp,'knights.yesno.violence',0,'Knight','yes',1,'matched',$1::timestamp,0,100),
              (2,1,$1::timestamp,'knights.yesno.violence',0,'Knight','no',1,'unmatched',$1::timestamp,0,0)`,
      [`${D1} 09:00:00`]
    );

    expect(await getRecap(db, { playerId: 1, now: NOON(D2) })).toMatchObject({
      cast: 4,
      confirmed: 2,
      graded: 2,
      goldEarned: 300,
      pending: 0,
    });
  });

  it('names the date when the last play day was not yesterday', async () => {
    await seedPlayer(pg, 1);
    await ledger(1, D1, { correct: 2 });
    expect(await getRecap(db, { playerId: 1, now: NOON(D4) })).toMatchObject({
      day: D1,
      when: 'on Dec 14',
    });
  });

  it('has no accuracy until something has settled', async () => {
    await seedPlayer(pg, 1);
    await ledger(1, D1, { pending: 4 });
    expect(await getRecap(db, { playerId: 1, now: NOON(D2) })).toMatchObject({
      confirmed: 0,
      graded: 0,
      accuracy: null,
      pending: 4,
    });
  });

  it('skips the days before it, and today itself', async () => {
    await seedPlayer(pg, 1);
    await ledger(1, '2026-12-12', { correct: 5 });
    await ledger(1, D1, { correct: 1 });
    await ledger(1, D2, { correct: 7 });
    expect(await getRecap(db, { playerId: 1, now: NOON(D2) })).toMatchObject({ day: D1, cast: 1 });
  });

  it('is empty for a player with no earlier play day', async () => {
    await seedPlayer(pg, 1);
    expect(await getRecap(db, { playerId: 1, now: NOON(D2) })).toBeNull();
    await ledger(1, D2, { correct: 3 });
    expect(await getRecap(db, { playerId: 1, now: NOON(D2) })).toBeNull();
  });

  it('stays dismissed for the rest of the UTC day, and returns the next day', async () => {
    await seedPlayer(pg, 1);
    await ledger(1, D1, { correct: 2 });

    await dismissRecap(db, { playerId: 1, now: NOON(D2) });
    expect(await getRecap(db, { playerId: 1, now: new Date(`${D2}T23:59:00Z`) })).toBeNull();

    await ledger(1, D2, { correct: 1 });
    expect(await getRecap(db, { playerId: 1, now: NOON(D3) })).toMatchObject({ day: D2 });
  });

  it('counts only the votes cast since a career reset', async () => {
    await seedPlayer(pg, 1);
    await ledger(1, D1, { correct: 5 }); // cast 08:01 .. 08:05
    await setStart(1, `${D1} 08:03:00`);
    expect(await getRecap(db, { playerId: 1, now: NOON(D2) })).toMatchObject({ day: D1, cast: 3 });
  });

  it('has no recap when every vote of the last day came before a mid-day reset', async () => {
    await seedPlayer(pg, 1);
    await ledger(1, D1, { correct: 3 }); // 08:01 .. 08:03
    await setStart(1, `${D1} 12:00:00`);
    expect(await getRecap(db, { playerId: 1, now: NOON(D2) })).toBeNull();
  });

  it('looks back past a day with only pre-reset votes to an earlier one that has some', async () => {
    await seedPlayer(pg, 1);
    await setStart(1, `${D1} 06:00:00`);
    await ledger(1, D1, { correct: 2 });
    await seedDay(1, D2, { votes: 4 }); // counter from before a reset; no ledger votes
    expect(await getRecap(db, { playerId: 1, now: NOON(D3) })).toMatchObject({ day: D1, cast: 2 });
  });

  it('has no recap for days before a career reset', async () => {
    await seedPlayer(pg, 1);
    await ledger(1, D1, { correct: 5 });
    await setStart(1, `${D2} 00:00:00`);
    expect(await getRecap(db, { playerId: 1, now: NOON(D2) })).toBeNull();
  });

  it('reports the streak bonus of that day apart from vote gold', async () => {
    await seedPlayer(pg, 1);
    await ledger(1, D1, { correct: 2 });
    await markWatch(1, D1, `${D1} 09:00:00`, 700);
    const recap = await getRecap(db, { playerId: 1, now: NOON(D2) });
    expect(recap).toMatchObject({ goldEarned: 200, streakBonus: 700 });
  });

  it('does not report a bonus for a Watch finished before a reset', async () => {
    await seedPlayer(pg, 1);
    await ledger(1, D1, { correct: 2 });
    await markWatch(1, D1, `${D1} 07:00:00`, 700);
    await setStart(1, `${D1} 08:00:00`);
    expect(await getRecap(db, { playerId: 1, now: NOON(D2) })).toMatchObject({ streakBonus: 0 });
  });

  it('counts only the player own votes', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await ledger(1, D1, { correct: 1 });
    await ledger(2, D1, { correct: 9 });
    expect(await getRecap(db, { playerId: 1, now: NOON(D2) })).toMatchObject({ cast: 1 });
  });
});
