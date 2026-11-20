import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { counterValue } from '../../../test/metrics';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ledgerOf } from '../progression/progression';
import { PROGRESSION } from '../progression/config';
import { ensureVotePartitions } from '../queue/queue.service';
import { SMITES } from '../smites/config';
import { activeSmiteCount } from '../smites/smites.service';
import { DEFAULT_HIDDEN_CHECKS } from './config';
import { answerHiddenCheck, readHiddenNotices } from './hidden.service';
import { closeNotice, SMITE_NOTICE, SMITE_REASON, warningNotice } from './notices';

const WARNING = { title: warningNotice(null, '').title };
import { settleHiddenChecks } from './settle';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const settings = { ...DEFAULT_HIDDEN_CHECKS, settleDelayMinutes: 30 };
const minutes = (m: number, from = NOW) => new Date(from.getTime() + m * 60_000);

vi.mock('../axiom', () => ({ logToAxiom: vi.fn() }));

let pg: PGlite;
let db: Kysely<DB>;
const resetPlayer = vi.fn<(id: number) => Promise<void>>(async () => undefined);
const mirror = vi.fn(async () => undefined);

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  vi.restoreAllMocks();
  resetPlayer.mockReset();
  resetPlayer.mockResolvedValue(undefined);
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsVote","KnightsPlayerDay","KnightsPlayer","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
  );
});

async function reference(imageId: number, answer = '4') {
  await seedImage(pg, imageId, { nsfwLevel: Number(answer) });
  const row = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey") VALUES ($1,'hiddenCheck',$2,'harvested',$3) RETURNING id`,
    [imageId, answer, Q]
  );
  return row.rows[0].id;
}
const answer = (userId: number, referenceId: number, value: string, at = NOW) =>
  answerHiddenCheck(db, { userId, referenceId, answer: value }, { now: () => at });
const settle = (at: Date) =>
  settleHiddenChecks(db, { now: at, settings, resetPlayer, mirrorXp: mirror as never });
const player = async (id: number) =>
  (
    await pg.query<{ exp: number; goldPending: number; goldEarned: number }>(
      `SELECT exp, "goldPending", "goldEarned" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [id]
    )
  ).rows[0];
const vote = async (id: number) =>
  (
    await pg.query<{
      verdict: string;
      settledAt: Date | null;
      consequence: string | null;
      gold: number;
    }>(
      `SELECT verdict, "settledAt", consequence, gold FROM "KnightsVote" WHERE "playerId"=$1 ORDER BY "createdAt"`,
      [id]
    )
  ).rows;
const smites = async (id: number) =>
  (
    await pg.query<{ size: number; givenById: number; reason: string }>(
      `SELECT size, "givenById", reason FROM "NewOrderSmite" WHERE "targetPlayerId"=$1 AND "cleansedAt" IS NULL`,
      [id]
    )
  ).rows;

describe('grading hidden checks', () => {
  it('leaves a check pending until its delay has passed', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10), '4');
    expect(await settle(minutes(29))).toMatchObject({ graded: 0 });
    expect((await vote(1))[0]).toMatchObject({ verdict: 'pending', settledAt: null });
  });

  it('pays a right answer like a correct vote: bulk XP, pending gold earned, and the accuracy ledger', async () => {
    await seedPlayer(pg, 1);
    const votesBefore = await counterValue('knights_votes_total', { kind: 'hidden_check' });
    await answer(1, await reference(10), '4');
    const before = await player(1);
    expect(before.goldPending).toBeGreaterThan(0);
    const gradedBefore = await counterValue('knights_hidden_checks_graded_total', {
      verdict: 'correct',
    });
    const goldBefore = await counterValue('knights_gold_earned_total', { source: 'hidden_check' });

    expect(await settle(minutes(31))).toMatchObject({ graded: 1, failed: 0 });

    expect(await counterValue('knights_votes_total', { kind: 'hidden_check' })).toBe(
      votesBefore + 1
    );
    expect(await counterValue('knights_hidden_checks_graded_total', { verdict: 'correct' })).toBe(
      gradedBefore + 1
    );
    expect(await counterValue('knights_gold_earned_total', { source: 'hidden_check' })).toBe(
      goldBefore + before.goldPending
    );

    const after = await player(1);
    expect(after.exp).toBe(before.exp + PROGRESSION.correctXp);
    expect(after.goldPending).toBe(0);
    expect(after.goldEarned).toBe(before.goldPending);
    expect((await vote(1))[0]).toMatchObject({ verdict: 'correct', consequence: null });
    expect(await ledgerOf(db, 1)).toEqual({ correct: 1, graded: 1 });
    expect(mirror).toHaveBeenCalledWith([{ playerId: 1, xp: PROGRESSION.correctXp }]);
  });

  it('works smites off on a right answer, as a correct queue vote does', async () => {
    await seedPlayer(pg, 1);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId","remaining") VALUES (1,5),(1,1)`);
    await answer(1, await reference(10), '4');
    await settle(minutes(31));
    const rows = (
      await pg.query<{ remaining: number; cleansedAt: Date | null }>(
        `SELECT remaining, "cleansedAt" FROM "NewOrderSmite" ORDER BY id`
      )
    ).rows;
    expect(rows[0]).toMatchObject({ remaining: 4, cleansedAt: null });
    expect(rows[1].cleansedAt).not.toBeNull();
  });

  it('works a smite off by every right answer settled in one sweep, not once per sweep', async () => {
    await seedPlayer(pg, 1);
    await pg.query(
      `INSERT INTO "NewOrderSmite" ("targetPlayerId","remaining") VALUES (1,10),(1,2)`
    );
    await answer(1, await reference(10), '4');
    await answer(1, await reference(11), '4', minutes(1));
    await answer(1, await reference(12), '4', minutes(2));
    await settle(minutes(40));
    const rows = (
      await pg.query<{ remaining: number; cleansedAt: Date | null }>(
        `SELECT remaining, "cleansedAt" FROM "NewOrderSmite" ORDER BY id`
      )
    ).rows;
    expect(rows[0]).toMatchObject({ remaining: 7, cleansedAt: null });
    expect(rows[1]).toMatchObject({ remaining: 0 });
    expect(rows[1].cleansedAt).not.toBeNull();
  });

  it('issues a skill-check smite that 25 right answers work off', async () => {
    expect(SMITES.size).toBe(25);
  });

  it('drops the gold of a wrong answer and warns the first time', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10, '4'), '16');
    const before = await player(1);
    await settle(minutes(31));
    const after = await player(1);
    expect(after.goldPending).toBe(0);
    expect(after.goldEarned).toBe(before.goldEarned);
    expect(after.exp).toBe(before.exp);
    expect((await vote(1))[0]).toMatchObject({ verdict: 'failed', consequence: 'warning' });
    expect(await smites(1)).toHaveLength(0);
    expect(await readHiddenNotices(db, 1)).toMatchObject([WARNING]);
  });

  it('does not show a notice from before a career reset to the new career', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10, '4'), '16');
    await settle(minutes(31));
    expect(await readHiddenNotices(db, 1)).toMatchObject([WARNING]);
    await pg.query(
      `UPDATE "NewOrderPlayer" SET "startAt" = '2026-12-16T00:00:00Z' WHERE "userId" = 1`
    );
    expect(await readHiddenNotices(db, 1)).toEqual([]);
  });

  it('smites on a repeat failure inside the window, with the original sizing and a neutral reason', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10, '4'), '16');
    await answer(1, await reference(11, '4'), '16', minutes(1));
    await settle(minutes(40));
    expect(await smites(1)).toEqual([
      { size: SMITES.size, givenById: SMITES.systemGiverId, reason: SMITE_REASON },
    ]);
    // One notice per check, newest first.
    expect(await readHiddenNotices(db, 1)).toMatchObject([SMITE_NOTICE, WARNING]);
    expect(SMITE_REASON).not.toMatch(/repeat|severe|another|24/i);
  });

  it('smites at once for rating far below the known answer', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10, '16'), '2');
    const before = await counterValue('knights_smites_total');
    await settle(minutes(31));
    expect(await smites(1)).toHaveLength(1);
    expect(await counterValue('knights_smites_total')).toBe(before + 1);
  });

  it('treats failures outside the window, or before a career reset, as no earlier failure', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await answer(1, await reference(10, '4'), '16');
    await settle(minutes(31));
    await answer(1, await reference(11, '4'), '16', minutes(60 * 30));
    await settle(minutes(60 * 31));
    expect(await smites(1)).toHaveLength(0);

    await answer(2, await reference(12, '4'), '16', minutes(60 * 40));
    await settle(minutes(60 * 41));
    await pg.query(`UPDATE "NewOrderPlayer" SET "startAt"=$1 WHERE "userId"=2`, [
      minutes(60 * 41 + 1),
    ]);
    await answer(2, await reference(13, '4'), '16', minutes(60 * 42));
    await settle(minutes(60 * 43));
    expect(await smites(2)).toHaveLength(0);
  });

  it('does not penalise a wrong answer given before the last career reset', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10, '16'), '2');
    await pg.query(`UPDATE "NewOrderPlayer" SET "startAt"=$1 WHERE "userId"=1`, [minutes(10)]);
    await settle(minutes(31));
    expect(await smites(1)).toHaveLength(0);
    expect((await vote(1))[0].consequence).toBeNull();
  });

  it('resets the career at the third active smite, and leaves it for the tick when that fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedPlayer(pg, 1);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (1),(1)`);
    await answer(1, await reference(10, '16'), '2');
    const before = await counterValue('knights_career_resets_total', { trigger: 'smites' });
    expect(await settle(minutes(31))).toMatchObject({ resets: 1 });
    expect(resetPlayer).toHaveBeenCalledWith(1);
    expect(await counterValue('knights_career_resets_total', { trigger: 'smites' })).toBe(
      before + 1
    );

    await seedPlayer(pg, 2);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (2),(2)`);
    resetPlayer.mockRejectedValue(new Error('main app down'));
    await answer(2, await reference(11, '16'), '2', minutes(40));
    expect(await settle(minutes(80))).toMatchObject({ resets: 0 });
    expect(await activeSmiteCount(db, 2)).toBe(3);
    expect(await counterValue('knights_career_resets_total', { trigger: 'smites' })).toBe(
      before + 1
    );
  });

  it('grades a check whose reference image is gone as inconclusive, paying nothing', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10);
    await answer(1, ref, '4');
    await pg.query(`DELETE FROM "KnightsReferenceImage" WHERE id=$1`, [ref]);
    await settle(minutes(31));
    expect((await vote(1))[0]).toMatchObject({ verdict: 'inconclusive' });
    expect(await ledgerOf(db, 1)).toEqual({ correct: 0, graded: 0 });
  });

  it.each([
    ['unpublished', `UPDATE "Post" SET "publishedAt"=NULL WHERE id=10`],
    ['blocked', `UPDATE "Image" SET "ingestion"='Blocked' WHERE id=10`],
  ])(
    'grades a check inconclusive, with no cost, when its image was %s since',
    async (_label, change) => {
      await seedPlayer(pg, 1);
      await answer(1, await reference(10, '16'), '2');
      await pg.query(change);
      await settle(minutes(31));
      expect((await vote(1))[0]).toMatchObject({ verdict: 'inconclusive', consequence: null });
      expect(await smites(1)).toHaveLength(0);
      expect((await player(1)).goldPending).toBe(0);
    }
  );

  it('grades a pending check whose reference was retired since as inconclusive, with no cost', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '16');
    await answer(1, ref, '2');
    await pg.query(`UPDATE "KnightsReferenceImage" SET status='retired' WHERE id=$1`, [ref]);
    await settle(minutes(31));
    expect((await vote(1))[0]).toMatchObject({ verdict: 'inconclusive', consequence: null });
    expect(await smites(1)).toHaveLength(0);
    expect((await player(1)).goldPending).toBe(0);
  });

  it('grades a check once', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10), '4');
    await settle(minutes(31));
    expect(await settle(minutes(32))).toMatchObject({ graded: 0 });
  });

  it('counts the check on its reference image when it is graded', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '4');
    await answer(1, ref, '16');
    await settle(minutes(31));
    const row = (
      await pg.query<{ answers: number; failures: number }>(
        `SELECT answers, failures FROM "KnightsReferenceImage" WHERE id=$1`,
        [ref]
      )
    ).rows[0];
    expect(row).toEqual({ answers: 1, failures: 1 });
  });
});

describe('retiring checks players keep failing', () => {
  const statusOf = async (id: number) =>
    (
      await pg.query<{ status: string }>(`SELECT status FROM "KnightsReferenceImage" WHERE id=$1`, [
        id,
      ])
    ).rows[0].status;

  it('retires a check once enough answers are in and more than half of them failed', async () => {
    for (const u of [1, 2]) await seedPlayer(pg, u);
    const ref = await reference(10, '4');
    await pg.query(`UPDATE "KnightsReferenceImage" SET answers=19, failures=10 WHERE id=$1`, [ref]);
    await answer(1, ref, '16');
    await settle(minutes(31));
    expect(await statusOf(ref)).toBe('retired');
  });

  it('keeps a check with too few answers, or failures at half or below', async () => {
    for (const u of [1, 2]) await seedPlayer(pg, u);
    const young = await reference(10, '4');
    const fair = await reference(11, '4');
    await pg.query(`UPDATE "KnightsReferenceImage" SET answers=5, failures=5 WHERE id=$1`, [young]);
    await pg.query(`UPDATE "KnightsReferenceImage" SET answers=39, failures=20 WHERE id=$1`, [
      fair,
    ]);
    await answer(1, young, '16');
    await answer(2, fair, '4');
    await settle(minutes(31));
    expect(await statusOf(young)).toBe('active');
    expect(await statusOf(fair)).toBe('active');
  });
});

describe('retiring mod-confirmed checks', () => {
  const statusOf = async (id: number) =>
    (
      await pg.query<{ status: string }>(`SELECT status FROM "KnightsReferenceImage" WHERE id=$1`, [
        id,
      ])
    ).rows[0].status;
  const inquisitorRef = async (imageId: number) => {
    const ref = await reference(imageId, '4');
    await pg.query(`UPDATE "KnightsReferenceImage" SET source='inquisitor' WHERE id=$1`, [ref]);
    return ref;
  };
  /** Earlier graded Knight answers on the check, as the ledger holds them. */
  const priorVotes = (ref: number, verdicts: string[]) =>
    pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict")
       SELECT $1, 1000 + n, $2::timestamp + (n || ' seconds')::interval, $3, 0, 'Knight', '4', 1, v
       FROM unnest($4::text[]) WITH ORDINALITY AS t(v, n)`,
      [-ref, '2026-12-14 00:00:00', Q, verdicts]
    );

  it('keeps an inquisitor check whose shared counters are past the bar when Knights mostly got it right', async () => {
    await seedPlayer(pg, 1);
    const ref = await inquisitorRef(10);
    await pg.query(`UPDATE "KnightsReferenceImage" SET answers=19, failures=15 WHERE id=$1`, [ref]);
    await priorVotes(ref, Array(19).fill('correct'));
    await answer(1, ref, '16');
    await settle(minutes(31));
    expect(await statusOf(ref)).toBe('active');
  });

  it('still retires a harvested check with the same shared counters', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '4');
    await pg.query(`UPDATE "KnightsReferenceImage" SET answers=19, failures=15 WHERE id=$1`, [ref]);
    await answer(1, ref, '16');
    await settle(minutes(31));
    expect(await statusOf(ref)).toBe('retired');
  });

  it('retires an inquisitor check once Knights hard-fail more than the bar, and counts it', async () => {
    await seedPlayer(pg, 1);
    const ref = await inquisitorRef(10);
    await priorVotes(ref, [...Array(10).fill('failed'), ...Array(9).fill('correct')]);
    const before = await counterValue('knights_skill_checks_retired_total', { reason: 'failures' });
    await answer(1, ref, '16');
    await settle(minutes(31));
    expect(await statusOf(ref)).toBe('retired');
    expect(await counterValue('knights_skill_checks_retired_total', { reason: 'failures' })).toBe(
      before + 1
    );
  });

  it('does not count close answers toward retiring an inquisitor check', async () => {
    await seedPlayer(pg, 1);
    const ref = await inquisitorRef(10);
    await priorVotes(ref, [...Array(10).fill('inconclusive'), ...Array(9).fill('failed')]);
    await answer(1, ref, '8');
    await settle(minutes(31));
    expect(await statusOf(ref)).toBe('active');
  });
});

describe('naming the check behind a notice', () => {
  it('names the image, the answer given and the answer it wanted', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10, '4'), '16');
    await settle(minutes(31));
    const [notice] = await readHiddenNotices(db, 1);
    expect(notice).toMatchObject({ consequence: 'warning', imageKey: expect.any(String) });
    // The warning names both judgments in its own words.
    expect(notice).toMatchObject(warningNotice(notice.correctLabel, notice.answerLabel));
    expect(notice.answerLabel).not.toBe(notice.correctLabel);
    expect(notice.correctLabel).toBeTruthy();
  });

  it('hides the image of a check that is no longer servable but still names the answers', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '4');
    await answer(1, ref, '16');
    await settle(minutes(31));
    await pg.query(`UPDATE "Image" SET "nsfwLevel" = 32 WHERE id = 10`);
    const [notice] = await readHiddenNotices(db, 1);
    expect(notice.imageKey).toBeNull();
    expect(notice.correctLabel).toBeTruthy();
  });
});

describe('grading a hidden check as it is answered', () => {
  const answerNow = (userId: number, referenceId: number, value: string, at = NOW) =>
    answerHiddenCheck(
      db,
      { userId, referenceId, answer: value },
      { now: () => at, mirrorXp: mirror as never, grade: { settings, resetPlayer } }
    );

  it('grades and pays a right answer in the same request', async () => {
    await seedPlayer(pg, 1);
    const result = await answerNow(1, await reference(10, '4'), '4');
    expect(result).toEqual({
      status: 'recorded',
      check: { verdict: 'correct', consequence: null, smites: 0, reset: false },
    });
    expect(await vote(1)).toMatchObject([{ verdict: 'correct', consequence: null }]);
    expect((await vote(1))[0].settledAt).not.toBeNull();
  });

  it('warns at once on a first wrong answer and smites the next one, one answer at a time', async () => {
    await seedPlayer(pg, 1);
    expect(await answerNow(1, await reference(10, '4'), '16')).toEqual({
      status: 'recorded',
      check: { verdict: 'failed', consequence: 'warning', smites: 0, reset: false },
    });
    expect(await readHiddenNotices(db, 1)).toHaveLength(1);
    expect(await answerNow(1, await reference(11, '4'), '16', minutes(1))).toEqual({
      status: 'recorded',
      check: { verdict: 'failed', consequence: 'smite', smites: 1, reset: false },
    });
    expect(await smites(1)).toHaveLength(1);
  });

  it('resets the career in the request that lands the third smite', async () => {
    await seedPlayer(pg, 1);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (1),(1)`);
    const result = await answerNow(1, await reference(10, '16'), '2');
    expect(result).toMatchObject({ check: { consequence: 'smite', smites: 3, reset: true } });
    expect(resetPlayer).toHaveBeenCalledWith(1);
  });

  it('leaves nothing for the tick to grade', async () => {
    await seedPlayer(pg, 1);
    await answerNow(1, await reference(10, '4'), '4');
    expect(await settle(minutes(60))).toMatchObject({ graded: 0 });
  });
});

describe('an answer one level off the reference', () => {
  const answerNow = (userId: number, referenceId: number, value: string, at = NOW) =>
    answerHiddenCheck(
      db,
      { userId, referenceId, answer: value },
      { now: () => at, mirrorXp: mirror as never, grade: { settings, resetPlayer } }
    );
  const counts = async (id: number) =>
    (
      await pg.query<{ answers: number; failures: number }>(
        `SELECT answers, failures FROM "KnightsReferenceImage" WHERE id=$1`,
        [id]
      )
    ).rows[0];

  it('is close, not failed: no payout, no warning, no smite, not in accuracy', async () => {
    await seedPlayer(pg, 1);
    const before = await player(1);
    const result = await answerNow(1, await reference(10, '4'), '8');
    expect(result).toEqual({
      status: 'recorded',
      check: { verdict: 'inconclusive', consequence: 'close', smites: 0, reset: false },
    });
    const after = await player(1);
    expect(after.goldPending).toBe(0);
    expect(after.goldEarned).toBe(before.goldEarned);
    expect(await smites(1)).toHaveLength(0);
    expect(await ledgerOf(db, 1)).toEqual({ correct: 0, graded: 0 });
  });

  it('is close one level under the reference too, and the tick grades it the same way', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10, '8'), '4');
    await settle(minutes(31));
    expect(await vote(1)).toMatchObject([{ verdict: 'inconclusive', consequence: 'close' }]);
  });

  it('still counts as a miss on the reference, so a borderline check keeps retiring', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '4');
    await answerNow(1, ref, '8');
    expect(await counts(ref)).toEqual({ answers: 1, failures: 1 });
  });

  it('is not an earlier failure: the next real miss is a warning, not a smite', async () => {
    await seedPlayer(pg, 1);
    await answerNow(1, await reference(10, '4'), '8');
    expect(await answerNow(1, await reference(11, '4'), '16', minutes(1))).toMatchObject({
      check: { verdict: 'failed', consequence: 'warning' },
    });
  });

  it('says it was close in the notice and names the reference answer', async () => {
    await seedPlayer(pg, 1);
    await answerNow(1, await reference(10, '4'), '8');
    const [notice] = await readHiddenNotices(db, 1);
    expect(notice).toMatchObject({ ...closeNotice(notice.correctLabel), consequence: 'close' });
    expect(notice.message).toContain(`The Order judged this image ${notice.correctLabel}`);
    expect(notice.correctLabel).toBeTruthy();
    expect(notice.correctLabel).not.toBe(notice.answerLabel);
  });

  it('treats Blocked next to the top level as a failure, not a close call', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '16');
    expect(
      await answerHiddenCheck(
        db,
        { userId: 1, referenceId: ref, answer: '32', blockReason: 'Bestiality' },
        { now: () => NOW, mirrorXp: mirror as never, grade: { settings, resetPlayer } }
      )
    ).toMatchObject({ check: { verdict: 'failed' } });
  });
});

describe('lock order', () => {
  it('locks the players before it touches a reference image, the order the vote path takes them', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await answer(2, await reference(10, '4'), '4');
    await answer(1, await reference(11, '4'), '16', minutes(1));
    const spy = vi.spyOn(pg, 'query');
    await settle(minutes(40));
    const sql = spy.mock.calls.map(([text]) => String(text));
    spy.mockRestore();

    const playerLock = sql.findIndex(
      (q) => /from "NewOrderPlayer"/i.test(q) && /for update/i.test(q)
    );
    const referenceWrite = sql.findIndex((q) => /update "KnightsReferenceImage"/i.test(q));
    expect(playerLock).toBeGreaterThan(-1);
    expect(playerLock).toBeLessThan(referenceWrite);
    expect(sql[playerLock]).toMatch(/order by "userId"/i);
  });
});
