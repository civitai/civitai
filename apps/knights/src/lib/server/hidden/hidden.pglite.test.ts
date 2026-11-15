import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { PROGRESSION } from '../progression/config';
import { castVote, ensureVotePartitions, getFeed, enqueueItem } from '../queue/queue.service';
import {
  answerHiddenCheck,
  hiddenItemId,
  pickHiddenCheck,
  readHiddenNotices,
} from './hidden.service';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const SECRET = 'test-secret';

let pg: PGlite;
let db: Kysely<DB>;
const deps = (now = NOW, voteLimits?: { windowSeconds: number; max: number }[]) => ({
  now: () => now,
  voteLimits,
});

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
  await pg.exec(`INSERT INTO "KnightsQuestion" ("key","kind","prompt","options")
    VALUES ('knights.test.other','choice','Other?','[{"value":"4","label":"R"},{"value":"8","label":"X"}]')`);
});
afterAll(() => pg.close());
beforeEach(async () => {
  vi.restoreAllMocks();
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
  );
});

async function reference(imageId: number, answer = '4', pool = 'hiddenCheck', question = Q) {
  await seedImage(pg, imageId, { nsfwLevel: Number(answer) });
  const row = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey") VALUES ($1,$2,$3,'harvested',$4) RETURNING id`,
    [imageId, pool, answer, question]
  );
  return row.rows[0].id;
}

const pick = (userId: number, rank = 'Knight', rate = 1, questionKey = Q, exclude: number[] = []) =>
  pickHiddenCheck(db, { userId, rank, secret: SECRET, questionKey, rate, exclude });
const answer = (userId: number, referenceId: number, value: string, now = NOW) =>
  answerHiddenCheck(db, { userId, referenceId, answer: value }, deps(now));

describe('serving a hidden check', () => {
  it('offers one at a rate of 1 and never at a rate of 0, without a pool or an answer in the offer', async () => {
    await seedPlayer(pg, 1);
    await reference(10);
    expect(await pick(1, 'Knight', 0)).toBeNull();
    const offer = await pick(1);
    expect(offer).toMatchObject({ imageKey: 'key-10', question: { key: Q } });
    expect(JSON.stringify(offer)).not.toMatch(/hiddenCheck|answer|pool/);
  });

  it('offers another check, not none, once the player skipped the one it chose', async () => {
    await seedPlayer(pg, 1);
    const ids = [await reference(10), await reference(11)];
    const first = (await pick(1))?.referenceId as number;
    const next = await pick(1, 'Knight', 1, Q, [first]);

    expect(next?.referenceId).toBe(ids.find((id) => id !== first));
    expect(await pick(1, 'Knight', 1, Q, ids)).toBeNull();
  });

  it('only offers a check for the question the feed is showing', async () => {
    await seedPlayer(pg, 1);
    await reference(10, '4', 'hiddenCheck', 'knights.test.other');
    expect(await pick(1)).toBeNull();
    expect(await pick(1, 'Knight', 1, 'knights.test.other')).toMatchObject({
      question: { key: 'knights.test.other' },
    });
  });

  it('reads the pool as often at a rate of 0 as at a rate of 1, so a page costs the same', async () => {
    await seedPlayer(pg, 1);
    await reference(10);
    const reads = async (rate: number) => {
      const spy = vi.spyOn(pg, 'query');
      await pick(1, 'Knight', rate);
      const count = spy.mock.calls.filter(([sql]) =>
        String(sql).includes('KnightsReferenceImage')
      ).length;
      spy.mockRestore();
      return count;
    };
    const off = await reads(0);
    expect(off).toBeGreaterThan(0);
    expect(await reads(1)).toBe(off);
  });

  it('is stable between reloads until the player answers something', async () => {
    await seedPlayer(pg, 1);
    for (let i = 10; i < 30; i++) await reference(i);
    const first = await pick(1);
    const again = await pick(1);
    expect(again?.referenceId).toBe(first?.referenceId);
  });

  it('skips Acolytes, the trials pool, unservable images and checks already answered', async () => {
    await seedPlayer(pg, 1, 'Acolyte');
    await seedPlayer(pg, 2);
    await reference(10, '4', 'trials');
    const hidden = await reference(11);
    await reference(12);
    await pg.query(`UPDATE "Post" SET "publishedAt"=NULL WHERE id=12`);
    expect(await pick(1, 'Acolyte')).toBeNull();
    expect((await pick(2))?.referenceId).toBe(hidden);
    await answer(2, hidden, '4');
    expect(await pick(2)).toBeNull();
  });

  it('finds the one check left whichever end of the pool the start point falls on', async () => {
    const ids: number[] = [];
    for (let i = 10; i < 20; i++) ids.push(await reference(i));
    for (let user = 1; user <= 6; user++) {
      await seedPlayer(pg, user);
      const left = ids[(user * 3) % ids.length];
      for (const id of ids) if (id !== left) await answer(user, id, '4');
      expect((await pick(user))?.referenceId).toBe(left);
    }
  });

  it('spreads picks across the pool even when its ids start high', async () => {
    await pg.exec(`SELECT setval(pg_get_serial_sequence('"KnightsReferenceImage"','id'), 4999)`);
    for (let i = 10; i < 21; i++) await reference(i);
    const picks = new Set<number>();
    for (let user = 1; user <= 12; user++) {
      await seedPlayer(pg, user);
      picks.add((await pick(user))?.referenceId as number);
    }
    expect(Math.min(...picks)).toBeGreaterThanOrEqual(5000);
    expect(picks.size).toBeGreaterThan(2);
  });

  it('is never queued, and a player who voted the image is not offered it', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await reference(10);
    expect(await getFeed(db, 1)).toBeNull();
    await enqueueItem(db, { questionKey: Q, imageId: 10, source: 'test' }, NOW);
    await castVote(
      db,
      { userId: 2, itemId: 1, answer: '4' },
      { applyConsensus: async () => ({ outcome: 'applied' }), now: () => NOW }
    );
    expect(await pick(2)).toBeNull();
  });

  it('keeps an image a player answered as a check out of their queue', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10);
    await answer(1, ref, '4');
    await enqueueItem(db, { questionKey: Q, imageId: 10, source: 'test' }, NOW);
    expect(await getFeed(db, 1)).toBeNull();
  });

  it('spreads offers evenly across the level buckets that have references, whatever their size', async () => {
    // A pool that is mostly PG, as harvested pools are: the draw must not follow the pool's shape.
    let imageId = 1000;
    for (let i = 0; i < 40; i++) await reference(imageId++, '1');
    for (const level of ['2', '4', '8', '16']) {
      for (let i = 0; i < 2; i++) await reference(imageId++, level);
    }
    const answers = new Map(
      (
        await pg.query<{ id: number; answer: string }>(
          `SELECT id, answer FROM "KnightsReferenceImage"`
        )
      ).rows.map((r) => [r.id, r.answer])
    );

    const counts = new Map<string, number>();
    for (let user = 1; user <= 100; user++) {
      const offer = await pick(user);
      const level = answers.get(offer?.referenceId as number) as string;
      counts.set(level, (counts.get(level) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(['1', '16', '2', '4', '8']);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThanOrEqual(10);
      expect(count).toBeLessThanOrEqual(30);
    }
  });

  it('offers a check to the same players at the same rate, whatever the pool holds', async () => {
    const offered = async () => {
      const users: number[] = [];
      for (let user = 1; user <= 60; user++) if (await pick(user, 'Knight', 0.25)) users.push(user);
      return users;
    };
    await reference(1000, '1');
    const single = await offered();
    let imageId = 1001;
    for (const level of ['2', '4', '8', '16', '1', '4']) await reference(imageId++, level);

    expect(await offered()).toEqual(single);
    expect(single.length).toBeGreaterThan(5);
    expect(single.length).toBeLessThan(30);
  });

  it('still offers the buckets a player has left once they answered every check in one', async () => {
    await seedPlayer(pg, 1);
    const pg13 = [await reference(10, '2'), await reference(11, '2')];
    const r = await reference(12, '4');
    for (const id of pg13) await answer(1, id, '2');
    expect((await pick(1))?.referenceId).toBe(r);
  });
});

describe('answering a hidden check', () => {
  const voteRow = async (userId: number) =>
    (
      await pg.query<Record<string, unknown>>(
        `SELECT "itemId","questionKey","imageId",stage,answer,verdict,xp,gold,labelled,"settledAt" FROM "KnightsVote" WHERE "playerId"=$1`,
        [userId]
      )
    ).rows;

  it('records an ordinary pending vote under the negated reference id, never labelled', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '8');
    expect(await answer(1, ref, '4')).toEqual({ status: 'recorded' });
    expect(await voteRow(1)).toEqual([
      expect.objectContaining({
        itemId: hiddenItemId(ref),
        imageId: 10,
        answer: '4',
        verdict: 'pending',
        xp: PROGRESSION.voteXp,
        labelled: true,
        settledAt: null,
      }),
    ]);
    expect((await pg.query(`SELECT 1 FROM "KnightsQueueItem"`)).rows).toHaveLength(0);
  });

  it('pays the vote XP and records the pending gold at once', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10);
    await answer(1, ref, '4');
    const p = (
      await pg.query<{ exp: number; goldPending: number }>(
        `SELECT exp, "goldPending" FROM "NewOrderPlayer" WHERE "userId"=1`
      )
    ).rows[0];
    expect(p.exp).toBe(PROGRESSION.voteXp);
    expect(p.goldPending).toBeGreaterThan(0);
  });

  it('refuses a second answer, an unknown option and a player who cannot judge', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2, 'Acolyte');
    const ref = await reference(10);
    expect(await answer(1, ref, '999')).toEqual({ status: 'rejected', reason: 'bad-answer' });
    await answer(1, ref, '4');
    expect(await answer(1, ref, '4')).toEqual({ status: 'rejected', reason: 'already-voted' });
    expect(await answer(2, ref, '4')).toEqual({ status: 'rejected', reason: 'not-eligible' });
    expect(await answer(9, ref, '4')).toEqual({ status: 'rejected', reason: 'no-player' });
    expect(await answer(1, 9999, '4')).toEqual({ status: 'rejected', reason: 'unavailable' });
  });

  it('answers a check whose image is gone exactly as it answers a queue item whose image is gone', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    const ref = await reference(10);
    await seedImage(pg, 11);
    const item = await enqueueItem(db, { questionKey: Q, imageId: 11, source: 'test' }, NOW);
    await pg.query(`UPDATE "Post" SET "publishedAt"=NULL WHERE id IN (10, 11)`);

    const asCheck = await answer(1, ref, '4');
    const asVote = await castVote(
      db,
      { userId: 2, itemId: item, answer: '4' },
      { applyConsensus: async () => ({ outcome: 'applied' }), now: () => NOW }
    );
    expect(asCheck).toEqual(asVote);
    expect(asCheck).toEqual({ status: 'rejected', reason: 'unavailable' });
    expect((await pg.query(`SELECT 1 FROM "KnightsVote"`)).rows).toHaveLength(0);
  });

  it('refuses like a vote while a career reset is pending', async () => {
    await seedPlayer(pg, 1);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (1),(1),(1)`);
    const ref = await reference(10);
    expect(await answer(1, ref, '4')).toEqual({ status: 'rejected', reason: 'reset-pending' });
  });

  it('is paced by the ledger it shares with votes, and its answers count toward the pace', async () => {
    await seedPlayer(pg, 1);
    const [a, b] = [await reference(10), await reference(11)];
    const limits = [{ windowSeconds: 60, max: 1 }];
    const first = await answerHiddenCheck(
      db,
      { userId: 1, referenceId: a, answer: '4' },
      deps(NOW, limits)
    );
    expect(first).toEqual({ status: 'recorded' });
    const second = await answerHiddenCheck(
      db,
      { userId: 1, referenceId: b, answer: '4' },
      deps(NOW, limits)
    );
    expect(second).toMatchObject({ status: 'limited' });
    expect(await voteRow(1)).toHaveLength(1);
  });

  it('asks a Blocked answer for a reason like a vote and stores it, the grade is on the level alone', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '4');
    expect(
      await answerHiddenCheck(db, { userId: 1, referenceId: ref, answer: '32' }, deps(NOW))
    ).toEqual({
      status: 'rejected',
      reason: 'bad-block-reason',
    });
    expect(await voteRow(1)).toHaveLength(0);

    expect(
      await answerHiddenCheck(
        db,
        { userId: 1, referenceId: ref, answer: '32', blockReason: 'Bestiality' },
        deps(NOW)
      )
    ).toEqual({ status: 'recorded' });
    expect(
      (await pg.query(`SELECT "blockReason" FROM "KnightsVote" WHERE "playerId"=1`)).rows
    ).toEqual([{ blockReason: 'Bestiality' }]);
  });

  it('has no cost for a wrong answer until it is graded', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '16');
    await answer(1, ref, '2');
    expect((await pg.query(`SELECT 1 FROM "NewOrderSmite"`)).rows).toHaveLength(0);
    expect(await readHiddenNotices(db, 1)).toEqual([]);
  });
});
