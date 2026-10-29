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
import { DEFAULT_HIDDEN_CHECKS, type HiddenCheckSettings } from './config';
import {
  answerHiddenCheck,
  isSevereUnderRating,
  pickHiddenCheck,
  takeHiddenNotices,
} from './hidden.service';
import { SMITE_NOTICE, WARNING_NOTICE } from './notices';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const SECRET = 'test-secret';
const settings: HiddenCheckSettings = { ...DEFAULT_HIDDEN_CHECKS };

let pg: PGlite;
let db: Kysely<DB>;
const resetPlayer = vi.fn<(id: number) => Promise<void>>(async () => undefined);
const deps = (now = NOW, voteLimits?: { windowSeconds: number; max: number }[]) => ({
  now: () => now,
  resetPlayer,
  settings,
  voteLimits,
});
const hoursLater = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
  await pg.exec(`INSERT INTO "KnightsQuestion" ("key","kind","prompt","options")
    VALUES ('knights.test.other','choice','Other?','[{"value":"4","label":"R"},{"value":"8","label":"X"}]')`);
});
afterAll(() => pg.close());
beforeEach(async () => {
  vi.restoreAllMocks();
  resetPlayer.mockReset();
  resetPlayer.mockResolvedValue(undefined);
  await pg.exec(
    `TRUNCATE "KnightsHiddenCheckAnswer","KnightsReferenceImage","KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
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
const smites = async (id: number) =>
  (
    await pg.query<{ size: number; remaining: number; givenById: number; reason: string }>(
      `SELECT size, remaining, "givenById", reason FROM "NewOrderSmite" WHERE "targetPlayerId"=$1 AND "cleansedAt" IS NULL`,
      [id]
    )
  ).rows;

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
  it('answers a right and a wrong check exactly as a vote is answered, and touches no queue, vote, XP or gold', async () => {
    await seedPlayer(pg, 1);
    const [right, wrong] = [await reference(10, '8'), await reference(11, '8')];
    expect(await answer(1, right, '8')).toEqual({ status: 'recorded' });
    expect(await answer(1, wrong, '4')).toEqual({ status: 'recorded' });
    expect((await pg.query(`SELECT 1 FROM "KnightsVote"`)).rows).toHaveLength(0);
    expect((await pg.query(`SELECT 1 FROM "KnightsQueueItem"`)).rows).toHaveLength(0);
    const p = (
      await pg.query<{ exp: number; goldPending: number }>(
        `SELECT exp, "goldPending" FROM "NewOrderPlayer" WHERE "userId"=1`
      )
    ).rows[0];
    expect(p).toMatchObject({ exp: 0 });
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

  it('refuses like a vote while a career reset is pending', async () => {
    await seedPlayer(pg, 1);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (1),(1),(1)`);
    const ref = await reference(10);
    expect(await answer(1, ref, '4')).toEqual({ status: 'rejected', reason: 'reset-pending' });
  });

  it('is paced like a vote', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10);
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
       VALUES (900,1,$1,$2,0,'Knight','4',1)`,
      [new Date(NOW.getTime() - 5_000), Q]
    );
    const result = await answerHiddenCheck(
      db,
      { userId: 1, referenceId: ref, answer: '4' },
      deps(NOW, [{ windowSeconds: 60, max: 1 }])
    );
    expect(result).toMatchObject({ status: 'limited' });
    expect((await pg.query(`SELECT 1 FROM "KnightsHiddenCheckAnswer"`)).rows).toHaveLength(0);
  });

  it('costs a first failure nothing but a warning, and the next failure a smite', async () => {
    await seedPlayer(pg, 1);
    const [a, b] = [await reference(10, '4'), await reference(11, '4')];
    await answer(1, a, '8');
    expect(await smites(1)).toHaveLength(0);
    expect(await takeHiddenNotices(db, 1, NOW)).toEqual([WARNING_NOTICE]);
    await answer(1, b, '8', hoursLater(1));
    expect(await smites(1)).toEqual([
      expect.objectContaining({
        size: SMITES.size,
        remaining: SMITES.size,
        givenById: SMITES.systemGiverId,
      }),
    ]);
    expect(await takeHiddenNotices(db, 1, NOW)).toEqual([SMITE_NOTICE]);
  });

  it('shows a notice once, and none for a right answer', async () => {
    await seedPlayer(pg, 1);
    const [a, b] = [await reference(10, '4'), await reference(11, '4')];
    await answer(1, a, '4');
    expect(await takeHiddenNotices(db, 1, NOW)).toEqual([]);
    await answer(1, b, '8');
    expect(await takeHiddenNotices(db, 1, NOW)).toHaveLength(1);
    expect(await takeHiddenNotices(db, 1, NOW)).toEqual([]);
  });

  it('stores a neutral reason on the smite', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '16');
    await answer(1, ref, '2');
    const [smite] = await smites(1);
    expect(smite.reason).not.toMatch(/repeat|severe|another|24/i);
  });

  it('treats a failure outside the window as a new first failure', async () => {
    await seedPlayer(pg, 1);
    const [a, b] = [await reference(10, '4'), await reference(11, '4')];
    await answer(1, a, '8');
    await answer(1, b, '8', hoursLater(30));
    expect(await smites(1)).toHaveLength(0);
  });

  it('ignores failures from before the last career reset', async () => {
    await seedPlayer(pg, 1);
    const [a, b] = [await reference(10, '4'), await reference(11, '4')];
    await answer(1, a, '8');
    await pg.query(`UPDATE "NewOrderPlayer" SET "startAt"=$1 WHERE "userId"=1`, [hoursLater(0.5)]);
    await answer(1, b, '8', hoursLater(1));
    expect(await smites(1)).toHaveLength(0);
  });

  it('smites at once for rating far below the known answer', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '16');
    await answer(1, ref, '2');
    expect(await smites(1)).toHaveLength(1);
    expect(isSevereUnderRating('8', '16', settings.severeDistance)).toBe(false);
    expect(isSevereUnderRating('4', '16', settings.severeDistance)).toBe(true);
    expect(isSevereUnderRating('16', '1', settings.severeDistance)).toBe(false);
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
    expect(await answer(1, ref, '1')).toEqual({ status: 'recorded' });
    expect(resetPlayer).toHaveBeenCalledTimes(1);
    expect(resetPlayer).toHaveBeenCalledWith(1);
  });

  it('leaves the smites active when the reset fails, so the tick can retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetPlayer.mockRejectedValue(new Error('main app down'));
    await seedPlayer(pg, 1);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (1),(1)`);
    const ref = await reference(10, '16');
    expect(await answer(1, ref, '1')).toEqual({ status: 'recorded' });
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
