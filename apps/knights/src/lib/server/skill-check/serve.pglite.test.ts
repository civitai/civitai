import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { answerApprentice, getApprentice } from '../apprenticeship/apprenticeship.service';
import { DEFAULT_HIDDEN_CHECKS } from '../hidden/config';
import { answerHiddenCheck, pickHiddenCheck } from '../hidden/hidden.service';
import { castVote, enqueueItem, ensureVotePartitions } from '../queue/queue.service';

vi.mock('../axiom', () => ({ logToAxiom: vi.fn() }));

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const SECRET = 'test-secret';
const settings = { ...DEFAULT_HIDDEN_CHECKS, settleDelayMinutes: 0 };
const resetPlayer = vi.fn(async () => undefined);

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsVote","KnightsQueueItem","KnightsApprenticeAnswer","KnightsPlayerDay","KnightsPlayer","NewOrderPlayer","NewOrderSmite","Image","Post","ImageReport","Report" RESTART IDENTITY CASCADE`
  );
});

async function skillCheck(imageId: number, answer = '4') {
  await seedImage(pg, imageId, { nsfwLevel: Number(answer) });
  const row = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey") VALUES ($1,'skillCheck',$2,'inquisitor',$3) RETURNING id`,
    [imageId, answer, Q]
  );
  return row.rows[0].id;
}
async function hiddenRef(imageId: number, answer = '4') {
  await seedImage(pg, imageId, { nsfwLevel: Number(answer) });
  const row = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey") VALUES ($1,'hiddenCheck',$2,'harvested',$3) RETURNING id`,
    [imageId, answer, Q]
  );
  return row.rows[0].id;
}
const pick = (userId: number, serveJudged = false) =>
  pickHiddenCheck(db, {
    userId,
    rank: 'Knight',
    secret: SECRET,
    questionKey: Q,
    rate: 1,
    serveJudged,
  });
const answer = (userId: number, referenceId: number, value: string, serveJudged = false) =>
  answerHiddenCheck(
    db,
    { userId, referenceId, answer: value, serveJudged },
    { now: () => NOW, grade: { settings, resetPlayer } }
  );
/** The player judged the image in the queue: a ledger vote on a real queue item. */
async function judgedInQueue(userId: number, imageId: number) {
  const itemId = await enqueueItem(db, { questionKey: Q, imageId, source: 'test' }, NOW);
  expect(await castVote(db, { userId, itemId, answer: '4' }, { now: () => NOW })).toMatchObject({
    status: expect.not.stringMatching('rejected'),
  });
}
const ledger = async (userId: number) =>
  (
    await pg.query<{ itemId: number; verdict: string; consequence: string | null }>(
      `SELECT "itemId",verdict,consequence FROM "KnightsVote" WHERE "playerId"=$1 ORDER BY "createdAt"`,
      [userId]
    )
  ).rows;

describe('serving mod-confirmed checks to Knights', () => {
  it('offers a skill-check row, also when it is the only kind in the pool', async () => {
    await seedPlayer(pg, 1);
    const id = await skillCheck(10);
    expect((await pick(1))?.referenceId).toBe(id);
  });

  it('offers both pools side by side', async () => {
    await seedPlayer(pg, 1);
    const ids = new Set([await hiddenRef(10), await skillCheck(11)]);
    const seen = new Set<number>();
    for (let player = 1; player <= 30; player++) {
      if (player > 1) await seedPlayer(pg, player);
      const offer = await pick(player);
      if (offer) seen.add(offer.referenceId);
    }
    expect(seen).toEqual(ids);
  });

  it.each([
    ['exact', '4', 'correct', null],
    ['one level off', '8', 'inconclusive', 'close'],
    ['two levels off', '16', 'failed', 'warning'],
  ])(
    'grades an %s answer by the hidden-check rule',
    async (_label, given, verdict, consequence) => {
      await seedPlayer(pg, 1);
      const id = await skillCheck(10, '4');
      expect(await answer(1, id, given)).toMatchObject({ status: 'recorded', check: { verdict } });
      expect(await ledger(1)).toEqual([{ itemId: -id, verdict, consequence }]);
    }
  );

  it('with the toggle off, never offers a check on an image the Knight judged and refuses a forged answer', async () => {
    await seedPlayer(pg, 1);
    const id = await skillCheck(10);
    await judgedInQueue(1, 10);
    expect(await pick(1)).toBeNull();
    expect(await answer(1, id, '4')).toEqual({ status: 'rejected', reason: 'already-voted' });
    expect((await ledger(1)).filter((v) => v.itemId < 0)).toEqual([]);
  });

  it('with the toggle on, offers and grades it, but never the same check twice, and never a judged hidden-check row', async () => {
    await seedPlayer(pg, 1);
    const id = await skillCheck(10);
    await judgedInQueue(1, 10);
    expect((await pick(1, true))?.referenceId).toBe(id);
    expect(await answer(1, id, '4', true)).toMatchObject({ status: 'recorded' });
    expect(await answer(1, id, '4', true)).toEqual({ status: 'rejected', reason: 'already-voted' });
    expect(await pick(1, true)).toBeNull();

    const hidden = await hiddenRef(11);
    await judgedInQueue(1, 11);
    expect(await pick(1, true)).toBeNull();
    expect(await answer(1, hidden, '4', true)).toEqual({
      status: 'rejected',
      reason: 'already-voted',
    });
  });

  it('with the toggle off, never offers a Knight a check on an image they answered as an Acolyte', async () => {
    await seedPlayer(pg, 1);
    const id = await skillCheck(10);
    await pg.query(
      `INSERT INTO "KnightsApprenticeAnswer" ("playerId","referenceId","imageId","questionKey","answer","correctAnswer","correct","xp","createdAt") VALUES (1,$1,10,$2,'4','4',true,0,$3)`,
      [id, Q, NOW]
    );
    expect(await pick(1)).toBeNull();
    expect((await pick(1, true))?.referenceId).toBe(id);
  });

  it('stops serving and accepting a pooled image that comes under a review after it entered', async () => {
    await seedPlayer(pg, 1);
    const id = await skillCheck(10);
    await pg.query(`INSERT INTO "Report" ("id","status") VALUES (70,'Pending')`);
    await pg.query(`INSERT INTO "ImageReport" ("reportId","imageId") VALUES (70,10)`);
    expect(await pick(1)).toBeNull();
    expect(await answer(1, id, '4')).toEqual({ status: 'rejected', reason: 'unavailable' });
  });
});

describe('one judgment per image for the other votes', () => {
  it('still refuses a queue rating on an image the player answered as a skill check, toggle on or off', async () => {
    await seedPlayer(pg, 1);
    const id = await skillCheck(10);
    await answer(1, id, '4', true);
    const itemId = await enqueueItem(db, { questionKey: Q, imageId: 10, source: 'test' }, NOW);
    expect(await castVote(db, { userId: 1, itemId, answer: '4' }, { now: () => NOW })).toEqual({
      status: 'rejected',
      reason: 'already-voted',
    });
  });
});

describe('serving mod-confirmed checks to Acolytes', () => {
  const core = async (imageId: number) => {
    await seedImage(pg, imageId);
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","explanation") VALUES ($1,'trials','4','core','why')`,
      [imageId]
    );
  };
  const served = async (userId: number, rate: number) => {
    const view = await getApprentice(db, userId, { skillCheckRate: rate });
    return view.kind === 'question' ? view.item : null;
  };

  it('mixes skill checks in with core images at the given rate, and serves none at a rate of 0', async () => {
    await seedPlayer(pg, 1, 'Acolyte');
    for (const id of [1, 2, 3]) await core(id);
    const check = await skillCheck(10);
    expect((await served(1, 0))?.referenceId).not.toBe(check);
    expect((await served(1, 1))?.referenceId).toBe(check);
  });

  it('grades a skill check by exact match, counting toward the bar like any trial image', async () => {
    await seedPlayer(pg, 1, 'Acolyte');
    await core(1);
    const check = await skillCheck(10, '4');
    expect((await served(1, 1))?.referenceId).toBe(check);
    expect(
      await answerApprentice(
        db,
        { userId: 1, kind: 'rating', referenceId: check, answer: '8' },
        { now: () => NOW, skillCheckRate: 1 }
      )
    ).toMatchObject({ status: 'recorded', correct: false });
    const answers = await pg.query(
      `SELECT "referenceId",correct FROM "KnightsApprenticeAnswer" WHERE "playerId"=1`
    );
    expect(answers.rows).toEqual([{ referenceId: check, correct: false }]);
  });

  it('does not serve an Acolyte a pooled image that came under a review', async () => {
    await seedPlayer(pg, 1, 'Acolyte');
    await core(1);
    const check = await skillCheck(10);
    await pg.query(`INSERT INTO "Report" ("id","status") VALUES (71,'Pending')`);
    await pg.query(`INSERT INTO "ImageReport" ("reportId","imageId") VALUES (71,10)`);
    expect((await served(1, 1))?.referenceId).not.toBe(check);
  });
});
