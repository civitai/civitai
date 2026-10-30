import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { bootLabelStore, createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer, seedSettledVote } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { runLabelPass } from './label-pass';

const NOW = new Date('2026-12-20T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;
const log = vi.fn();

const pass = (extra: { batchSize?: number; budgetMs?: number } = {}) =>
  runLabelPass(db, { now: NOW, log, ...extra });
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
    `TRUNCATE "KnightsGoldConversion", "KnightsVote", "KnightsPlayerDay", "NewOrderPlayer", "User" RESTART IDENTITY;
     TRUNCATE label_store.subject, label_store.erased_subject, label_store.record_failure CASCADE`
  );
});

describe('the pass log', () => {
  it('reports the Buzz converted per day when it wrote labels', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(pg, { itemId: 1, playerId: 1, imageId: 101 });
    await pg.exec(
      `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId","paidAt") VALUES
        (1,10000,10,'paid','a','2026-12-20 08:00:00'),(1,5000,5,'paid','b','2026-12-20 09:00:00'),
        (1,7000,7,'paid','c','2026-12-19 09:00:00'),(1,9000,9,'pending','d',NULL)`
    );

    await pass();

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'knights-label-pass',
        details: expect.objectContaining({
          labelsWritten: 1,
          buzzConvertedPerDay: [
            { day: '2026-12-19', buzz: 7, conversions: 1 },
            { day: '2026-12-20', buzz: 15, conversions: 2 },
          ],
        }),
      })
    );
  });

  it('stays quiet on a tick with nothing to write', async () => {
    await pass();

    expect(log).not.toHaveBeenCalled();
  });
});

describe('a pass that runs out of time', () => {
  it('stays open and finishes on the next tick', async () => {
    await seedPlayer(pg, 1);
    await seedSettledVote(pg, { itemId: 1, playerId: 1, imageId: 101 });

    expect(await pass({ budgetMs: 0 })).toMatchObject({ done: false, labelsWritten: 0 });
    expect(await labels()).toEqual([]);

    expect(await pass()).toMatchObject({ done: true, labelsWritten: 1 });
    expect(await pass()).toMatchObject({ done: true, labelsWritten: 0 });
  });
});

describe('labels', () => {
  const vote = (itemId: number, playerId: number, imageId: number, answer = '4') =>
    seedSettledVote(pg, { itemId, playerId, imageId, answer });

  it('writes one knight label per settled vote on the tick, with no check run in between', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await vote(1, 1, 101, '4');
    await vote(1, 2, 101, '8');
    await vote(2, 1, 102, '4');

    expect(await pass()).toMatchObject({ labelsWritten: 3, labelFailures: 0 });

    const written = await labels();
    expect(written).toHaveLength(3);
    expect(written.map((l) => l.value).sort()).toEqual(['4', '4', '8']);
    expect(written.every((l) => l.labellerKind === 'knight')).toBe(true);
    expect(written.every((l) => l.question === 'knights.image.nsfwLevel')).toBe(true);
    expect(written.every((l) => /^KnightsVote:\d+:[0-9a-f]{64}$/.test(l.sourceRef))).toBe(true);
    expect(await labelled(1)).toEqual([true, true]);
  });

  it('writes none again on a later tick', async () => {
    await seedPlayer(pg, 1);
    await vote(1, 1, 101);

    await pass();
    expect(await pass()).toMatchObject({ labelsWritten: 0 });

    expect(await labels()).toHaveLength(1);
  });

  it('does not write again when a vote lost its mark but kept its label', async () => {
    await seedPlayer(pg, 1);
    await vote(1, 1, 101);
    await pass();
    await pg.exec(`UPDATE "KnightsVote" SET "labelled"=false`);

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

    await pass();
    expect(await labels()).toHaveLength(1);
    expect(await labelled(2)).toEqual([false]);

    await release(2);
    await pass();
    expect(await labels()).toHaveLength(2);
    expect(await labelled(2)).toEqual([true]);
  });

  it('leaves a vote that has not been graded yet', async () => {
    await seedPlayer(pg, 1);
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
       VALUES (1,1,'2026-12-10 10:00:00','knights.image.nsfwLevel',101,'Knight','4',1)`
    );

    await pass();
    expect(await labels()).toEqual([]);

    await pg.exec(
      `UPDATE "KnightsVote" SET "settledAt"='2026-12-10 11:00:00', "verdict"='correct'`
    );
    await pass();
    expect(await labels()).toHaveLength(1);
  });

  it('only marks a vote whose image is gone', async () => {
    await seedPlayer(pg, 1);
    await vote(1, 1, 999);

    expect(await pass()).toMatchObject({ labelsWritten: 0, labelFailures: 0 });

    expect(await labels()).toEqual([]);
    expect(await labelled(1)).toEqual([true]);
  });

  it('gives the rating question a rule once, and leaves a bool question that has no producer id alone', async () => {
    await pg.exec(
      `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options","version") VALUES ('knights.image.flag','bool','Flag?','[]'::jsonb,1)
       ON CONFLICT DO NOTHING`
    );
    await pass();
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
      failures.push((await pass()).labelFailures);
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

      expect(await pass()).toMatchObject({ done: true, labelsWritten: 2, labelFailures: 1 });
      expect(await labels()).toHaveLength(2);
      expect(await labelled(2)).toEqual([false]);

      for (let i = 0; i < 5; i++) {
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

  it('does not label a vote on a bool question that has no producer id', async () => {
    await pg.exec(
      `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('knights.image.flag','bool','Flag?','[]'::jsonb) ON CONFLICT DO NOTHING`
    );
    await seedPlayer(pg, 1);
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict","xp","settledAt")
       VALUES (7,1,'2026-12-10 10:00:00','knights.image.flag',101,'Knight','yes',1,'correct',0,'2026-12-10 11:00:00')`
    );

    await pass();

    expect(await labels()).toEqual([]);
  });
});
