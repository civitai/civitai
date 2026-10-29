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

const pick = (userId: number, rank = 'Knight', rate = 1, questionKey = Q) =>
  pickHiddenCheck(db, { userId, rank, secret: SECRET, questionKey, rate });
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

  it('has no cost for a wrong answer until it is graded', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '16');
    await answer(1, ref, '2');
    expect((await pg.query(`SELECT 1 FROM "NewOrderSmite"`)).rows).toHaveLength(0);
    expect(await readHiddenNotices(db, 1)).toEqual([]);
  });
});
