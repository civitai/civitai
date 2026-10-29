import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ledgerOf } from '../progression/progression';
import { PROGRESSION } from '../progression/config';
import { ensureVotePartitions } from '../queue/queue.service';
import { SMITES } from '../smites/config';
import { activeSmiteCount } from '../smites/smites.service';
import { DEFAULT_HIDDEN_CHECKS } from './config';
import { answerHiddenCheck, readHiddenNotices } from './hidden.service';
import { SMITE_NOTICE, SMITE_REASON, WARNING_NOTICE } from './notices';
import { settleHiddenChecks } from './settle';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const settings = { ...DEFAULT_HIDDEN_CHECKS, settleDelayMinutes: 30 };
const minutes = (m: number, from = NOW) => new Date(from.getTime() + m * 60_000);

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
    await answer(1, await reference(10), '4');
    const before = await player(1);
    expect(before.goldPending).toBeGreaterThan(0);

    expect(await settle(minutes(31))).toMatchObject({ graded: 1, failed: 0 });

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

  it('drops the gold of a wrong answer and warns the first time', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10, '4'), '8');
    const before = await player(1);
    await settle(minutes(31));
    const after = await player(1);
    expect(after.goldPending).toBe(0);
    expect(after.goldEarned).toBe(before.goldEarned);
    expect(after.exp).toBe(before.exp);
    expect((await vote(1))[0]).toMatchObject({ verdict: 'failed', consequence: 'warning' });
    expect(await smites(1)).toHaveLength(0);
    expect(await readHiddenNotices(db, 1)).toEqual([WARNING_NOTICE]);
  });

  it('smites on a repeat failure inside the window, with the original sizing and a neutral reason', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10, '4'), '8');
    await answer(1, await reference(11, '4'), '8', minutes(1));
    await settle(minutes(40));
    expect(await smites(1)).toEqual([
      { size: SMITES.size, givenById: SMITES.systemGiverId, reason: SMITE_REASON },
    ]);
    expect(await readHiddenNotices(db, 1)).toEqual([SMITE_NOTICE]);
    expect(SMITE_REASON).not.toMatch(/repeat|severe|another|24/i);
  });

  it('smites at once for rating far below the known answer', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10, '16'), '2');
    await settle(minutes(31));
    expect(await smites(1)).toHaveLength(1);
  });

  it('treats failures outside the window, or before a career reset, as no earlier failure', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await answer(1, await reference(10, '4'), '8');
    await settle(minutes(31));
    await answer(1, await reference(11, '4'), '8', minutes(60 * 30));
    await settle(minutes(60 * 31));
    expect(await smites(1)).toHaveLength(0);

    await answer(2, await reference(12, '4'), '8', minutes(60 * 40));
    await settle(minutes(60 * 41));
    await pg.query(`UPDATE "NewOrderPlayer" SET "startAt"=$1 WHERE "userId"=2`, [
      minutes(60 * 41 + 1),
    ]);
    await answer(2, await reference(13, '4'), '8', minutes(60 * 42));
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
    expect(await settle(minutes(31))).toMatchObject({ resets: 1 });
    expect(resetPlayer).toHaveBeenCalledWith(1);

    await seedPlayer(pg, 2);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (2),(2)`);
    resetPlayer.mockRejectedValue(new Error('main app down'));
    await answer(2, await reference(11, '16'), '2', minutes(40));
    expect(await settle(minutes(80))).toMatchObject({ resets: 0 });
    expect(await activeSmiteCount(db, 2)).toBe(3);
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

  it('grades a check once', async () => {
    await seedPlayer(pg, 1);
    await answer(1, await reference(10), '4');
    await settle(minutes(31));
    expect(await settle(minutes(32))).toMatchObject({ graded: 0 });
  });

  it('counts the check on its reference image when it is graded', async () => {
    await seedPlayer(pg, 1);
    const ref = await reference(10, '4');
    await answer(1, ref, '8');
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
