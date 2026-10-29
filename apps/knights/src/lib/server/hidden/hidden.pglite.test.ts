import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ledgerOf } from '../progression/progression';
import { castVote, ensureVotePartitions, getFeed, enqueueItem } from '../queue/queue.service';
import { SMITES } from '../smites/config';
import { activeSmiteCount } from '../smites/smites.service';
import { answerHiddenCheck, isSevereUnderRating, pickHiddenCheck } from './hidden.service';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const SECRET = 'test-secret';

let pg: PGlite;
let db: Kysely<DB>;
const resetPlayer = vi.fn<(id: number) => Promise<void>>(async () => undefined);
const deps = (now = NOW) => ({ now: () => now, resetPlayer });
const hoursLater = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  resetPlayer.mockReset();
  resetPlayer.mockResolvedValue(undefined);
  await pg.exec(
    `TRUNCATE "KnightsHiddenCheckAnswer","KnightsReferenceImage","KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
  );
});

async function reference(imageId: number, answer = '4', pool = 'hiddenCheck') {
  await seedImage(pg, imageId, { nsfwLevel: Number(answer) });
  const row = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source") VALUES ($1,$2,$3,'harvested') RETURNING id`,
    [imageId, pool, answer]
  );
  return row.rows[0].id;
}

const answer = (userId: number, referenceId: number, value: string, now = NOW) =>
  answerHiddenCheck(db, { userId, referenceId, answer: value }, deps(now));
const smites = async (id: number) =>
  (
    await pg.query<{ size: number; remaining: number; givenById: number }>(
      `SELECT size, remaining, "givenById" FROM "NewOrderSmite" WHERE "targetPlayerId"=$1 AND "cleansedAt" IS NULL`,
      [id]
    )
  ).rows;

describe('serving a hidden check', () => {
  it('offers one at a rate of 1 and never at a rate of 0, without a pool or an answer in the offer', async () => {
    await seedPlayer(pg, 1);
    await reference(10);
    expect(
      await pickHiddenCheck(db, { userId: 1, rank: 'Knight', secret: SECRET, rate: 0 })
    ).toBeNull();
    const offer = await pickHiddenCheck(db, { userId: 1, rank: 'Knight', secret: SECRET, rate: 1 });
    expect(offer).toMatchObject({ imageKey: 'key-10', question: { key: Q } });
    const text = JSON.stringify(offer);
    expect(text).not.toMatch(/hiddenCheck|answer|pool/);
  });

  it('is stable between reloads until the player answers something', async () => {
    await seedPlayer(pg, 1);
    for (let i = 10; i < 30; i++) await reference(i);
    const first = await pickHiddenCheck(db, { userId: 1, rank: 'Knight', secret: SECRET, rate: 1 });
    const again = await pickHiddenCheck(db, { userId: 1, rank: 'Knight', secret: SECRET, rate: 1 });
    expect(again?.referenceId).toBe(first?.referenceId);
  });

  it('skips Acolytes, the trials pool, unservable images and checks already answered', async () => {
    await seedPlayer(pg, 1, 'Acolyte');
    await seedPlayer(pg, 2);
    const trials = await reference(10, '4', 'trials');
    const hidden = await reference(11);
    const gone = await reference(12);
    await pg.query(`UPDATE "Post" SET "publishedAt"=NULL WHERE id=12`);
    const pick = (userId: number, rank: string) =>
      pickHiddenCheck(db, { userId, rank, secret: SECRET, rate: 1 });
    expect(await pick(1, 'Acolyte')).toBeNull();
    expect((await pick(2, 'Knight'))?.referenceId).toBe(hidden);
    await answer(2, hidden, '4');
    expect(await pick(2, 'Knight')).toBeNull();
    expect([trials, gone]).toBeDefined();
  });

  it('is never queued: the feed has no item for it and a player who voted the image is not offered it', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    const ref = await reference(10);
    expect(await getFeed(db, 1)).toBeNull();
    await enqueueItem(db, { questionKey: Q, imageId: 10, source: 'test' }, NOW);
    await castVote(
      db,
      { userId: 2, itemId: 1, answer: '4' },
      { applyConsensus: async () => ({ outcome: 'applied' }), now: () => NOW }
    );
    expect(
      await pickHiddenCheck(db, { userId: 2, rank: 'Knight', secret: SECRET, rate: 1 })
    ).toBeNull();
    expect(ref).toBeGreaterThan(0);
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
  it('grades a right answer at once and touches no queue, vote, XP or gold', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '8');
    const result = await answer(1, ref, '8');
    expect(result).toMatchObject({ status: 'graded', correct: true, consequence: 'none' });
    expect((await pg.query(`SELECT 1 FROM "KnightsVote"`)).rows).toHaveLength(0);
    expect((await pg.query(`SELECT 1 FROM "KnightsQueueItem"`)).rows).toHaveLength(0);
    const p = (await pg.query<{ exp: number }>(`SELECT exp FROM "NewOrderPlayer" WHERE "userId"=1`))
      .rows[0];
    expect(p.exp).toBe(0);
    expect(await smites(1)).toHaveLength(0);
  });

  it('refuses a second answer, an unknown option and a player who cannot judge', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2, 'Acolyte');
    const ref = await reference(10);
    expect(await answer(1, ref, '999')).toEqual({ status: 'rejected', reason: 'bad-answer' });
    await answer(1, ref, '4');
    expect(await answer(1, ref, '4')).toEqual({ status: 'rejected', reason: 'already-answered' });
    expect(await answer(2, ref, '4')).toEqual({ status: 'rejected', reason: 'not-eligible' });
    expect(await answer(9, ref, '4')).toEqual({ status: 'rejected', reason: 'no-player' });
    expect(await answer(1, 9999, '4')).toEqual({ status: 'rejected', reason: 'unavailable' });
  });

  it('warns on a first failure and smites on a second within the window', async () => {
    await seedPlayer(pg, 1);
    const [a, b] = [await reference(10, '4'), await reference(11, '4')];
    expect(await answer(1, a, '8')).toMatchObject({ correct: false, consequence: 'warning' });
    expect(await smites(1)).toHaveLength(0);
    expect(await answer(1, b, '8', hoursLater(1))).toMatchObject({
      consequence: 'smite',
      activeSmites: 1,
    });
    expect(await smites(1)).toEqual([
      { size: SMITES.size, remaining: SMITES.size, givenById: SMITES.systemGiverId },
    ]);
  });

  it('treats a failure outside the window as a new first failure', async () => {
    await seedPlayer(pg, 1);
    const [a, b] = [await reference(10, '4'), await reference(11, '4')];
    await answer(1, a, '8');
    expect(await answer(1, b, '8', hoursLater(30))).toMatchObject({ consequence: 'warning' });
  });

  it('smites at once for rating two or more levels below the known answer', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '16');
    expect(await answer(1, ref, '2')).toMatchObject({ consequence: 'smite' });
    expect(isSevereUnderRating('8', '16')).toBe(false);
    expect(isSevereUnderRating('4', '16')).toBe(true);
    expect(isSevereUnderRating('16', '1')).toBe(false);
  });

  it('counts the failure on the reference image', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10);
    await answer(1, ref, '8');
    const row = (
      await pg.query<{ answers: number; failures: number }>(
        `SELECT answers, failures FROM "KnightsReferenceImage" WHERE id=$1`,
        [ref]
      )
    ).rows[0];
    expect(row).toEqual({ answers: 1, failures: 1 });
  });

  it('resets the career at the third active smite, once', async () => {
    await seedPlayer(pg, 1);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (1),(1)`);
    const ref = await reference(10, '16');
    expect(await answer(1, ref, '1')).toMatchObject({ consequence: 'reset', activeSmites: 0 });
    expect(resetPlayer).toHaveBeenCalledTimes(1);
    expect(resetPlayer).toHaveBeenCalledWith(1);
  });

  it('leaves the smites active when the reset fails, so the tick can retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetPlayer.mockRejectedValue(new Error('main app down'));
    await seedPlayer(pg, 1);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (1),(1)`);
    const ref = await reference(10, '16');
    expect(await answer(1, ref, '1')).toMatchObject({ consequence: 'smite', activeSmites: 3 });
    expect(await activeSmiteCount(db, 1)).toBe(3);
  });

  it('counts in the accuracy ledger, and not before a career reset', async () => {
    await seedPlayer(pg, 1);
    const [a, b, c] = [await reference(10), await reference(11), await reference(12)];
    await answer(1, a, '4');
    await answer(1, b, '4');
    await answer(1, c, '8');
    expect(await ledgerOf(db, 1)).toEqual({ correct: 2, graded: 3 });
    await pg.query(`UPDATE "NewOrderPlayer" SET "startAt"=$1 WHERE "userId"=1`, [hoursLater(1)]);
    expect(await ledgerOf(db, 1)).toEqual({ correct: 0, graded: 0 });
  });
});
