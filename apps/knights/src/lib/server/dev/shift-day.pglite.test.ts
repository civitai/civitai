import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedPlayer } from '../../../test/seed';
import { getRecap } from '../daily/daily.service';
import { ensureVotePartitions } from '../queue/queue.service';
import { shiftMyDayBack } from './shift-day';

const TODAY = '2026-12-15';
const NOW = new Date(`${TODAY}T12:00:00Z`);

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE "KnightsVote","NewOrderPlayer","KnightsPlayer","KnightsPlayerDay"`);
});

const castVoteRow = (playerId: number, itemId: number, at: string) =>
  pg.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict","settledAt","xp","gold")
     VALUES ($1,$2,$3,'knights.image.nsfwLevel',0,'Knight','4',1,'correct',$3,0,100)`,
    [itemId, playerId, at]
  );

const days = async (playerId: number) =>
  (
    await pg.query<{ day: string }>(
      `SELECT day::text FROM "KnightsPlayerDay" WHERE "playerId"=$1 ORDER BY day`,
      [playerId]
    )
  ).rows.map((r) => r.day);

const voteTimes = async (playerId: number) =>
  (
    await pg.query<{ at: string }>(
      `SELECT to_char("createdAt",'YYYY-MM-DD HH24:MI') AS at FROM "KnightsVote" WHERE "playerId"=$1 ORDER BY "createdAt"`,
      [playerId]
    )
  ).rows.map((r) => r.at);

async function playedToday(playerId: number) {
  await seedPlayer(pg, playerId);
  await castVoteRow(playerId, 1, `${TODAY} 09:30:00`);
  await pg.query(`INSERT INTO "KnightsPlayerDay" ("playerId","day","votes") VALUES ($1,$2,1)`, [
    playerId,
    TODAY,
  ]);
  await pg.query(
    `INSERT INTO "KnightsPlayer" ("playerId","streak","lastWatchDay","shields","shieldWeek","recapDismissedFor")
     VALUES ($1,3,$2,1,'2026-12-14',$2)`,
    [playerId, TODAY]
  );
}

describe('shiftMyDayBack', () => {
  it('moves the day rows, the votes and the streak markers back one day', async () => {
    await playedToday(1);

    expect(await shiftMyDayBack(db, 1)).toEqual({ ok: true, days: 1 });

    expect(await days(1)).toEqual(['2026-12-14']);
    expect(await voteTimes(1)).toEqual(['2026-12-14 09:30']);
    const keeper = (
      await pg.query<{ lastWatchDay: string; recapDismissedFor: string; streak: number }>(
        `SELECT "lastWatchDay"::text,"recapDismissedFor"::text,streak FROM "KnightsPlayer" WHERE "playerId"=1`
      )
    ).rows[0];
    expect(keeper).toEqual({
      lastWatchDay: '2026-12-14',
      recapDismissedFor: '2026-12-14',
      streak: 3,
    });
  });

  it('makes yesterday of what was today, so the recap shows', async () => {
    await playedToday(1);
    await shiftMyDayBack(db, 1);
    expect(await getRecap(db, { playerId: 1, now: NOW })).toMatchObject({
      day: '2026-12-14',
      cast: 1,
      confirmed: 1,
    });
  });

  it('keeps earlier days one apart when shifted again', async () => {
    await playedToday(1);
    await shiftMyDayBack(db, 1);
    await pg.query(`INSERT INTO "KnightsPlayerDay" ("playerId","day","votes") VALUES (1,$1,2)`, [
      TODAY,
    ]);

    await shiftMyDayBack(db, 1);

    expect(await days(1)).toEqual(['2026-12-13', '2026-12-14']);
  });

  it('crosses a month boundary into a partition that does not exist yet', async () => {
    await seedPlayer(pg, 1);
    await castVoteRow(1, 1, '2026-12-01 09:30:00');
    await pg.query(
      `INSERT INTO "KnightsPlayerDay" ("playerId","day","votes") VALUES (1,'2026-12-01',1)`
    );
    await pg.exec(`DROP TABLE IF EXISTS "KnightsVote_2026_11"`);

    expect(await shiftMyDayBack(db, 1)).toEqual({ ok: true, days: 1 });
    expect(await voteTimes(1)).toEqual(['2026-11-30 09:30']);
  });

  it('leaves every other player alone', async () => {
    await playedToday(1);
    await playedToday(2);

    await shiftMyDayBack(db, 1);

    expect(await days(2)).toEqual([TODAY]);
    expect(await voteTimes(2)).toEqual([`${TODAY} 09:30`]);
  });

  it('moves the time a Watch was completed by exactly one day', async () => {
    await playedToday(1);
    await pg.query(
      `UPDATE "KnightsPlayerDay" SET "watchCompletedAt"='${TODAY} 10:15:00' WHERE "playerId"=1`
    );

    await shiftMyDayBack(db, 1);

    const row = await pg.query<{ at: string }>(
      `SELECT to_char("watchCompletedAt",'YYYY-MM-DD HH24:MI') AS at FROM "KnightsPlayerDay" WHERE "playerId"=1`
    );
    expect(row.rows[0].at).toBe('2026-12-14 10:15');
  });

  it('moves a reset made within the shifted days, and leaves an older one', async () => {
    await playedToday(1);
    await playedToday(2);
    await pg.query(`UPDATE "NewOrderPlayer" SET "startAt"='${TODAY} 08:00:00' WHERE "userId"=1`);
    await pg.query(`UPDATE "NewOrderPlayer" SET "startAt"='2020-03-01 08:00:00' WHERE "userId"=2`);

    await shiftMyDayBack(db, 1);
    await shiftMyDayBack(db, 2);

    const starts = await pg.query<{ userId: number; at: string }>(
      `SELECT "userId", to_char("startAt",'YYYY-MM-DD HH24:MI') AS at FROM "NewOrderPlayer" ORDER BY "userId"`
    );
    expect(starts.rows.map((r) => r.at)).toEqual(['2026-12-14 08:00', '2020-03-01 08:00']);
  });

  it('says so when there is nothing to shift', async () => {
    await seedPlayer(pg, 1);
    expect(await shiftMyDayBack(db, 1)).toEqual({ ok: false, reason: 'nothing-to-shift' });
  });
});
