import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { bootLabelStore, createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer, seedSettledVote } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { runLabelPass } from './label-pass';
import { hasUnlabelled, refPrefix } from './labels';

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
/** Moves every recorded failure back past the retry age, as if the time had passed. */
const wait = () =>
  pg.exec(`UPDATE label_store.record_failure SET "createdAt" = "createdAt" - interval '1 hour'`);
/** The prefix a give-up logs for a player: the store's keyed hash, which the user id cannot be recovered from. */
const prefixOf = async (userId: number) =>
  (
    await pg.query<{ p: string }>(`SELECT left(label_store.person_hash('labeller', $1), 12) AS p`, [
      userId,
    ])
  ).rows[0].p;
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

  it('never labels a hidden check (negative item id) and the pass still ends', async () => {
    await seedPlayer(pg, 1);
    await vote(-5, 1, 101, '4');
    await vote(2, 1, 102, '8');

    expect(await pass()).toMatchObject({ done: true, labelsWritten: 1, labelFailures: 0 });
    expect(await pass()).toMatchObject({ done: true, labelsWritten: 0, labelFailures: 0 });

    expect((await labels()).map((l) => l.value)).toEqual(['8']);
    expect(await hasUnlabelled(db, 'rating')).toBe(false);
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

  it('never labels a vote cast while held, even once the hold is cleared', async () => {
    await seedPlayer(pg, 1);
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict","xp","settledAt")
       VALUES (1,1,'2026-12-10 10:00:00','knights.image.nsfwLevel',101,'Knight','4',0,'correct',10,'2026-12-10 11:00:00')`
    );

    await pass();
    expect(await labels()).toEqual([]);
    expect(await hasUnlabelled(db, 'rating')).toBe(false);
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
    await vote(1, 1, 101);
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
      await wait();
    }

    expect(failures.slice(0, 5)).toEqual([1, 1, 1, 1, 1]);
    expect(failures.slice(-2)).toEqual([0, 0]);
    expect(await labelled(1)).toEqual([true]);
    expect(await labels()).toHaveLength(1);
  });

  it('logs each pass with failures at error level, and the vote it gives up on once', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await vote(1, 1, 101);
    await vote(2, 2, 102);
    await pg.exec(
      `INSERT INTO label_store.erased_subject ("subjectType","subjectId") VALUES ('image','101')`
    );

    for (let i = 0; i < 8; i++) {
      await pass();
      await wait();
    }

    const named = (name: string) => log.mock.calls.map((c) => c[0]).filter((e) => e.name === name);
    expect(named('knights-label-failures')).toHaveLength(5);
    expect(named('knights-label-failures')[0]).toMatchObject({
      type: 'error',
      details: { labelFailures: 1 },
    });
    const gaveUp = named('knights-label-given-up');
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]).toMatchObject({
      type: 'error',
      details: { kind: 'rating', itemId: 1, refPrefix: expect.stringMatching(/^[0-9a-f]{12}$/) },
    });
    expect(JSON.stringify(gaveUp[0])).not.toMatch(/playerId|userId/);
    expect(gaveUp[0].details.refPrefix).toBe(await prefixOf(1));
  });

  it('takes the hash after the last colon of a ref, so a yes/no id with colons keeps its prefix', () => {
    const hash = 'abcdef0123456789'.repeat(4);
    expect(refPrefix(`KnightsYesNoVote:set:7:${hash}`)).toBe('abcdef012345');
    expect(refPrefix(`KnightsVote:9:${hash}`)).toBe('abcdef012345');
  });

  it('logs and rethrows when the pass itself raises', async () => {
    await expect(runLabelPass({} as never, { now: NOW, log })).rejects.toThrow();

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'knights-label-pass-failed' })
    );
  });

  it('does not try a refused vote again before the retry age', async () => {
    await seedPlayer(pg, 1);
    await vote(1, 1, 101);
    await pg.exec(
      `INSERT INTO label_store.erased_subject ("subjectType","subjectId") VALUES ('image','101')`
    );

    expect(await pass()).toMatchObject({ labelFailures: 1 });
    expect(await pass()).toMatchObject({ labelFailures: 0 });
    expect(
      (await pg.query(`SELECT count(*)::int AS n FROM label_store.record_failure`)).rows
    ).toEqual([{ n: 1 }]);
  });

  it('writes nothing and sets up no rules on a tick with no votes waiting', async () => {
    await pg.exec(`DELETE FROM label_store.rule WHERE "question" LIKE 'knights.%'`);
    await pass();

    expect(
      (await pg.query(`SELECT 1 FROM label_store.rule WHERE "question" LIKE 'knights.%'`)).rows
    ).toEqual([]);
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

    it('logs the same keyed prefix for a player on the row-by-row path as on the batch path', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await seedPlayer(pg, 2);
      await vote(1, 2, 102);
      // A raise outside the store's own error handling, so the batch falls back to one vote at a time.
      const textHash = (body: string) => `
        CREATE OR REPLACE FUNCTION label_store.text_hash(p_text TEXT) RETURNS TEXT
        LANGUAGE plpgsql IMMUTABLE AS $$
        BEGIN ${body} RETURN encode(sha256(convert_to(p_text, 'UTF8')), 'hex'); END $$`;
      await pg.exec(textHash(`IF p_text = 'key-102' THEN RAISE EXCEPTION 'boom'; END IF;`));

      try {
        for (let i = 0; i < 7; i++) {
          await pass();
          await wait();
        }
      } finally {
        await pg.exec(`
          CREATE OR REPLACE FUNCTION label_store.text_hash(p_text TEXT) RETURNS TEXT
          LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex') $$`);
      }

      const gaveUp = log.mock.calls
        .map((c) => c[0])
        .filter((e) => e.name === 'knights-label-given-up');
      expect(gaveUp).toHaveLength(1);
      expect(gaveUp[0].details.refPrefix).toBe(await prefixOf(2));
      const unkeyed = (
        await pg.query<{ p: string }>(`SELECT left(label_store.text_hash('2'), 12) AS p`)
      ).rows[0].p;
      expect(gaveUp[0].details.refPrefix).not.toBe(unkeyed);
    });

    it('still labels every vote once the store is back after being down for several ticks', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const id of [1, 2, 3]) await seedPlayer(pg, id);
      await vote(1, 1, 101);
      await vote(2, 2, 102);
      await vote(3, 3, 103);
      await pg.exec(personHash(`RAISE EXCEPTION 'store down';`));

      for (let i = 0; i < 8; i++) {
        await pass();
        await wait();
      }
      expect(await labelled(1)).toEqual([false]);

      await pg.exec(personHash(''));
      expect(await pass()).toMatchObject({ labelsWritten: 3, labelFailures: 0 });
      expect(await labels()).toHaveLength(3);
    });

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
        await wait();
        await pass();
      }

      expect(await labelled(2)).toEqual([true]);
      expect(await labels()).toHaveLength(2);
      expect(
        log.mock.calls.map((c) => c[0]).filter((e) => e.name === 'knights-label-given-up')
      ).toEqual([
        expect.objectContaining({
          type: 'error',
          details: {
            kind: 'rating',
            itemId: 2,
            refPrefix: null, // the fixture breaks the store's hash for this player, so there is none to log
          },
        }),
      ]);
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
