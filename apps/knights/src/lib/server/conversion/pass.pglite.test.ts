import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { bootLabelStore, createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer, seedSettledVote, setGold } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { getGoldBalance } from './balance';
import { runPostDetectionPass } from './pass';

const NOW = new Date('2026-12-20T12:00:00Z');
const RUN_AT = '2026-12-12 00:00:00';

let pg: PGlite;
let db: Kysely<DB>;
const log = vi.fn();

const run = async (completedAt = RUN_AT) =>
  (
    await pg.query<{ id: number }>(
      `INSERT INTO "KnightsDetectionRun" ("completedAt") VALUES ($1::timestamp) RETURNING id`,
      [completedAt]
    )
  ).rows[0].id;
const pass = (extra: { batchSize?: number; budgetMs?: number } = {}) =>
  runPostDetectionPass(db, { now: NOW, log, ...extra });
const cleared = async (userId: number) =>
  (
    await pg.query<{ goldCleared: number }>(
      `SELECT "goldCleared" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [userId]
    )
  ).rows[0].goldCleared;
const labels = async () =>
  (
    await pg.query<{ sourceRef: string; value: string; labellerKind: string; question: string }>(
      `SELECT "sourceRef","value","labellerKind","question" FROM label_store.label ORDER BY id`
    )
  ).rows;
const labelled = async (playerId: number) =>
  (
    await pg.query<{ labelled: boolean }>(
      `SELECT "labelled" FROM "KnightsVote" WHERE "playerId"=$1 ORDER BY "itemId"`,
      [playerId]
    )
  ).rows.map((r) => r.labelled);
const hold = (userId: number) =>
  pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"='2026-12-11' WHERE "userId"=${userId}`);
const release = (userId: number) =>
  pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"=NULL WHERE "userId"=${userId}`);

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await bootLabelStore(pg);
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
  for (const id of [101, 102, 103, 104]) await seedImage(pg, id);
}, 120_000);
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  log.mockReset();
  await pg.exec(
    `TRUNCATE "KnightsDetectionRun", "KnightsGoldClearing", "KnightsGoldConversion", "KnightsVote", "KnightsPlayerDay", "NewOrderPlayer", "User" RESTART IDENTITY;
     TRUNCATE label_store.subject, label_store.erased_subject, label_store.record_failure CASCADE`
  );
});

describe('gold clearing', () => {
  it('clears earned gold after a detection run, and nothing before one', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(pg, { itemId: 1, playerId: 1, imageId: 101, gold: 100 });
    await setGold(pg, 1, { earned: 100 });

    expect(await pass()).toEqual({ ran: false });
    expect(await getGoldBalance(db, 1)).toMatchObject({ awaitingDetection: 100, convertible: 0 });

    const runId = await run();
    expect(await pass()).toMatchObject({
      ran: true,
      runId,
      done: true,
      clearedPlayers: 1,
      clearedGold: 100,
    });

    expect(await getGoldBalance(db, 1)).toMatchObject({ awaitingDetection: 0, convertible: 100 });
    expect(
      (await pg.query(`SELECT "playerId","runId","gold" FROM "KnightsGoldClearing"`)).rows
    ).toEqual([{ playerId: 1, runId, gold: 100 }]);
  });

  it('leaves gold earned after the run for the next run', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(pg, { itemId: 1, playerId: 1, imageId: 101, gold: 100 });
    await seedSettledVote(pg, {
      itemId: 2,
      playerId: 1,
      imageId: 102,
      gold: 100,
      createdAt: '2026-12-13 10:00:00',
      settledAt: '2026-12-13 11:00:00',
    });
    await pg.exec(
      `INSERT INTO "KnightsPlayerDay" ("playerId","day","votes","watchCompletedAt","bonusGold") VALUES (1,'2026-12-13',5,'2026-12-13 12:00:00',50)`
    );
    await setGold(pg, 1, { earned: 250 });

    await run();
    await pass();
    expect(await cleared(1)).toBe(100);

    await run('2026-12-14 00:00:00');
    await pass();
    expect(await cleared(1)).toBe(250);
  });

  it('keeps a held player frozen, and clears them once they are released', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    for (const [id, p] of [
      [1, 1],
      [2, 2],
    ])
      await seedSettledVote(pg, { itemId: id, playerId: p, imageId: 100 + id, gold: 100 });
    await setGold(pg, 1, { earned: 100 });
    await setGold(pg, 2, { earned: 100 });
    await hold(2);

    await run();
    await pass();
    expect(await getGoldBalance(db, 1)).toMatchObject({ convertible: 100, frozen: 0 });
    expect(await getGoldBalance(db, 2)).toMatchObject({ convertible: 0, frozen: 100 });

    await release(2);
    await run('2026-12-14 00:00:00');
    await pass();
    expect(await getGoldBalance(db, 2)).toMatchObject({ convertible: 100, frozen: 0 });
  });

  it('does not clear a banned account', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(pg, { itemId: 1, playerId: 1, imageId: 101, gold: 100 });
    await setGold(pg, 1, { earned: 100 });
    await pg.exec(`INSERT INTO "User" ("id","bannedAt") VALUES (1,'2026-12-01')`);

    await run();
    await pass();

    expect(await cleared(1)).toBe(0);
  });

  it('clears nothing twice, and gives Acolytes with no gold no row', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2, 'Acolyte');
    await seedSettledVote(pg, { itemId: 1, playerId: 1, imageId: 101, gold: 100 });
    await setGold(pg, 1, { earned: 100 });

    await run();
    await pass();
    await run('2026-12-14 00:00:00');
    expect(await pass()).toMatchObject({ clearedPlayers: 0, clearedGold: 0 });

    expect(await cleared(1)).toBe(100);
    expect(await getGoldBalance(db, 2)).toMatchObject({ convertible: 0, frozen: 0, pending: 0 });
    expect(await pg.query(`SELECT 1 FROM "KnightsGoldClearing"`)).toMatchObject({
      rows: [expect.anything()],
    });
  });

  it('covers every player across batches', async () => {
    for (const id of [1, 2, 3, 4, 5]) {
      await seedPlayer(pg, id);
      await setGold(pg, id, { earned: 10 });
    }

    await run();
    expect(await pass({ batchSize: 2 })).toMatchObject({
      clearedPlayers: 5,
      clearedGold: 50,
      done: true,
    });
  });

  it('logs the pass with the Buzz converted per day', async () => {
    await seedPlayer(pg, 1);
    await pg.exec(
      `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId","paidAt") VALUES
        (1,10000,10,'paid','a','2026-12-20 08:00:00'),(1,5000,5,'paid','b','2026-12-20 09:00:00'),
        (1,7000,7,'paid','c','2026-12-19 09:00:00'),(1,9000,9,'pending','d',NULL)`
    );
    await run();

    await pass();

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'knights-post-detection-pass',
        details: expect.objectContaining({
          buzzConvertedPerDay: [
            { day: '2026-12-19', buzz: 7, conversions: 1 },
            { day: '2026-12-20', buzz: 15, conversions: 2 },
          ],
        }),
      })
    );
  });
});

describe('a pass that runs out of time', () => {
  it('stays open and finishes on the next tick', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(pg, { itemId: 1, playerId: 1, imageId: 101, gold: 100 });
    await setGold(pg, 1, { earned: 100 });
    const runId = await run();

    expect(await pass({ budgetMs: 0 })).toMatchObject({
      ran: true,
      runId,
      done: false,
      clearedGold: 0,
    });
    expect(await labels()).toEqual([]);
    expect(await cleared(1)).toBe(0);

    expect(await pass()).toMatchObject({ done: true, clearedGold: 100, labelsWritten: 1 });
    expect(await pass()).toEqual({ ran: false });
  });
});

describe('labels', () => {
  const vote = (itemId: number, playerId: number, imageId: number, answer = '4') =>
    seedSettledVote(pg, { itemId, playerId, imageId, answer });

  it('writes one knight label per vote after detection, never before', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await vote(1, 1, 101, '4');
    await vote(1, 2, 101, '8');
    await vote(2, 1, 102, '4');

    expect(await pass()).toEqual({ ran: false });
    expect(await labels()).toEqual([]);

    await run();
    expect(await pass()).toMatchObject({ labelsWritten: 3, labelFailures: 0 });

    const written = await labels();
    expect(written).toHaveLength(3);
    expect(written.map((l) => l.value).sort()).toEqual(['4', '4', '8']);
    expect(written.every((l) => l.labellerKind === 'knight')).toBe(true);
    expect(written.every((l) => l.question === 'knights.image.nsfwLevel')).toBe(true);
    expect(written.every((l) => /^KnightsVote:\d+:[0-9a-f]{64}$/.test(l.sourceRef))).toBe(true);
    expect(await labelled(1)).toEqual([true, true]);
  });

  it('writes none again on a later run', async () => {
    await seedPlayer(pg, 1);
    await vote(1, 1, 101);

    await run();
    await pass();
    await run('2026-12-14 00:00:00');
    expect(await pass()).toMatchObject({ labelsWritten: 0 });

    expect(await labels()).toHaveLength(1);
  });

  it('does not write again when a vote lost its mark but kept its label', async () => {
    await seedPlayer(pg, 1);
    await vote(1, 1, 101);
    await run();
    await pass();
    await pg.exec(`UPDATE "KnightsVote" SET "labelled"=false`);

    await run('2026-12-14 00:00:00');
    expect(await pass()).toMatchObject({ labelsWritten: 0, labelFailures: 0 });

    expect(await labels()).toHaveLength(1);
    expect(await labelled(1)).toEqual([true]);
  });

  it('skips a held player, then writes the labels once they are released', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await vote(1, 1, 101);
    await vote(1, 2, 101);
    await hold(2);

    await run();
    await pass();
    expect(await labels()).toHaveLength(1);
    expect(await labelled(2)).toEqual([false]);

    await release(2);
    await run('2026-12-14 00:00:00');
    await pass();
    expect(await labels()).toHaveLength(2);
    expect(await labelled(2)).toEqual([true]);
  });

  it('waits for the next run for a vote settled after the last one', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(pg, {
      itemId: 1,
      playerId: 1,
      imageId: 101,
      createdAt: '2026-12-13 10:00:00',
      settledAt: '2026-12-13 11:00:00',
    });

    await run();
    await pass();
    expect(await labels()).toEqual([]);

    await run('2026-12-14 00:00:00');
    await pass();
    expect(await labels()).toHaveLength(1);
  });

  it('only marks a vote whose image is gone', async () => {
    await seedPlayer(pg, 1);
    await vote(1, 1, 999);

    await run();
    expect(await pass()).toMatchObject({ labelsWritten: 0, labelFailures: 0 });

    expect(await labels()).toEqual([]);
    expect(await labelled(1)).toEqual([true]);
  });

  it('gives the rating question a rule once, and leaves yes/no questions alone', async () => {
    await pg.exec(
      `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options","version") VALUES ('knights.image.flag','bool','Flag?','[]'::jsonb,1)
       ON CONFLICT DO NOTHING`
    );
    await run();
    await pass();
    await run('2026-12-14 00:00:00');
    await pass();

    expect(
      (
        await pg.query(
          `SELECT "question","questionVersion","minHuman","requireUnanimous" FROM label_store.rule WHERE "question" LIKE 'knights.%'`
        )
      ).rows
    ).toEqual([
      {
        question: 'knights.image.nsfwLevel',
        questionVersion: 1,
        minHuman: 5,
        requireUnanimous: false,
      },
    ]);
  });

  it('gives up on a vote the store keeps refusing, after a few tries', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await vote(1, 1, 101);
    await vote(2, 2, 102);
    await pg.exec(
      `INSERT INTO label_store.erased_subject ("subjectType","subjectId") VALUES ('image','101')`
    );

    const failures: number[] = [];
    for (let i = 0; i < 8; i++) {
      await run(`2026-12-${13 + i} 00:00:00`);
      const result = await pass();
      failures.push(result.ran ? result.labelFailures : -1);
    }

    expect(failures.slice(0, 5)).toEqual([1, 1, 1, 1, 1]);
    expect(failures.slice(-2)).toEqual([0, 0]);
    expect(await labelled(1)).toEqual([true]);
    expect(await labels()).toHaveLength(1);
  });

  describe('when the store raises for one vote', () => {
    const personHash = (raiseFor: string) => `
      CREATE OR REPLACE FUNCTION label_store.person_hash(p_kind TEXT, p_user_id INTEGER)
      RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = label_store, pg_temp AS $$
      BEGIN
        ${raiseFor}
        RETURN (SELECT encode(sha256(convert_to(s."key" || ':' || p_kind || ':' || p_user_id, 'UTF8')), 'hex')
                FROM label_store.secret s);
      END $$`;
    afterEach(() => pg.exec(personHash('')));

    it('writes the other votes of the batch, records the failure and gives up on that vote after a few passes', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const id of [1, 2, 3]) await seedPlayer(pg, id);
      await vote(1, 1, 101);
      await vote(2, 2, 102);
      await vote(3, 3, 103);
      await pg.exec(personHash(`IF p_user_id = 2 THEN RAISE EXCEPTION 'boom'; END IF;`));

      await run();
      expect(await pass()).toMatchObject({ done: true, labelsWritten: 2, labelFailures: 1 });
      expect(await labels()).toHaveLength(2);
      expect(await labelled(2)).toEqual([false]);

      for (let i = 0; i < 5; i++) {
        await run(`2026-12-${13 + i} 00:00:00`);
        await pass();
      }

      expect(await labelled(2)).toEqual([true]);
      expect(await labels()).toHaveLength(2);
      expect(
        (
          await pg.query(
            `SELECT count(*)::int AS n FROM label_store.record_failure WHERE "sourceRef" LIKE 'KnightsVoteError:%'`
          )
        ).rows
      ).toEqual([{ n: 5 }]);
    });
  });

  it('does not label yes/no votes', async () => {
    await pg.exec(
      `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('knights.image.flag','bool','Flag?','[]'::jsonb) ON CONFLICT DO NOTHING`
    );
    await seedPlayer(pg, 1);
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict","xp","settledAt")
       VALUES (7,1,'2026-12-10 10:00:00','knights.image.flag',101,'Knight','yes',1,'correct',0,'2026-12-10 11:00:00')`
    );

    await run();
    await pass();

    expect(await labels()).toEqual([]);
  });
});
