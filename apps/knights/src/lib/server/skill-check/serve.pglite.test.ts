import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import {
  answerApprentice,
  getApprentice,
  getApprenticeProgress,
} from '../apprenticeship/apprenticeship.service';
import { ACOLYTE_WRONG_ANSWER_SMITE } from '../smites/config';
import { DEFAULT_HIDDEN_CHECKS } from '../hidden/config';
import { answerHiddenCheck, pickHiddenCheck, readHiddenNotices } from '../hidden/hidden.service';
import { listJudgments } from '../progression/judgments';
import {
  castVote,
  enqueueItem,
  ensureVotePartitions,
  type QueueDeps,
} from '../queue/queue.service';
import {
  EXCLUSION_TABLES,
  exclusionCases,
  extraExclusionCases,
} from '../../../test/skill-check-exclusions';

vi.mock('../axiom', () => ({ logToAxiom: vi.fn() }));

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const SECRET = 'test-secret';
const settings = { ...DEFAULT_HIDDEN_CHECKS, settleDelayMinutes: 0 };
const resetPlayer = vi.fn(async () => undefined);
/** Votes here never settle an item, so the write-back is never called. */
const queueDeps: QueueDeps = {
  applyConsensus: async () => ({ outcome: 'applied' }),
  now: () => NOW,
};

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsVote","KnightsQueueItem","KnightsApprenticeAnswer","KnightsPlayerDay","KnightsPlayer","NewOrderPlayer","NewOrderSmite","Image","Post",${EXCLUSION_TABLES} RESTART IDENTITY CASCADE`
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
const pick = (userId: number, serveJudged = false, skillChecks = true) =>
  pickHiddenCheck(db, {
    userId,
    rank: 'Knight',
    secret: SECRET,
    questionKey: Q,
    rate: 1,
    serveJudged,
    skillChecks,
  });
const answer = (
  userId: number,
  referenceId: number,
  value: string,
  serveJudged = false,
  skillChecks = true
) =>
  answerHiddenCheck(
    db,
    { userId, referenceId, answer: value, serveJudged, skillChecks },
    { now: () => NOW, grade: { settings, resetPlayer } }
  );
/** The player judged the image in the queue: a ledger vote on a real queue item. */
async function judgedInQueue(userId: number, imageId: number) {
  const itemId = await enqueueItem(db, { questionKey: Q, imageId, source: 'test' }, NOW);
  expect(await castVote(db, { userId, itemId, answer: '4' }, queueDeps)).toMatchObject({
    status: 'recorded',
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
  it('serves and accepts none while the inquisitor queue is switched off', async () => {
    await seedPlayer(pg, 1);
    const id = await skillCheck(10);
    expect(await pick(1, false, false)).toBeNull();
    expect(await answer(1, id, '4', false, false)).toEqual({
      status: 'rejected',
      reason: 'unavailable',
    });
  });

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

describe('a pooled image that comes under an exclusion', () => {
  const cases = [...exclusionCases(() => pg), ...extraExclusionCases(() => pg)];

  it.each(cases)(
    'is no longer served to a Knight or accepted once it has %s',
    async (_label, flag) => {
      await seedPlayer(pg, 1);
      const id = await skillCheck(10);
      expect((await pick(1))?.referenceId).toBe(id);
      await flag(10);
      expect(await pick(1)).toBeNull();
      expect(await answer(1, id, '4')).toEqual({ status: 'rejected', reason: 'unavailable' });
    }
  );

  it.each(cases)('is no longer served to an Acolyte once it has %s', async (_label, flag) => {
    await seedPlayer(pg, 1, 'Acolyte');
    await seedImage(pg, 1);
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","explanation") VALUES (1,'trials','4','core','why')`
    );
    const id = await skillCheck(10);
    await flag(10);
    const view = await getApprentice(db, 1, { skillCheckRate: 1 });
    expect(view.kind).toBe('question');
    expect(view.kind === 'question' && view.item.referenceId).not.toBe(id);
  });
});

describe('showing an answered mod-confirmed image again', () => {
  it('hides it in the Knight notice once it comes under a hold', async () => {
    await seedPlayer(pg, 1);
    const id = await skillCheck(10, '4');
    await answer(1, id, '16');
    expect((await readHiddenNotices(db, 1))[0]?.imageKey).toBe('key-10');
    await pg.query(`UPDATE "Image" SET "tosViolation"=true WHERE id=10`);
    expect((await readHiddenNotices(db, 1))[0]?.imageKey).toBeNull();
  });

  it('hides it in the Acolyte recap once it comes under a hold', async () => {
    await seedPlayer(pg, 1, 'Acolyte');
    for (let i = 0; i < 19; i++) {
      await seedImage(pg, 100 + i);
      const ref = await pg.query<{ id: number }>(
        `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","status") VALUES ($1,'trials','4','harvested','retired') RETURNING id`,
        [100 + i]
      );
      await pg.query(
        `INSERT INTO "KnightsApprenticeAnswer" ("playerId","referenceId","imageId","questionKey","answer","correctAnswer","correct","xp","createdAt") VALUES (1,$1,$2,$3,'4','4',true,0,$4)`,
        [ref.rows[0].id, 100 + i, Q, new Date(NOW.getTime() - (20 - i) * 1000)]
      );
    }
    const check = await skillCheck(10, '4');
    const view = await getApprentice(db, 1, { skillCheckRate: 1 });
    expect(view.kind === 'question' && view.item.referenceId).toBe(check);
    await answerApprentice(
      db,
      { userId: 1, kind: 'rating', referenceId: check, answer: '16' },
      { now: () => NOW, skillCheckRate: 1 }
    );
    const recap = async () => {
      const v = await getApprentice(db, 1, { skillCheckRate: 1 });
      expect(v.kind).toBe('checkpoint');
      return v.kind === 'checkpoint' ? v.checkpoint.missed[0]?.imageKey : undefined;
    };
    expect(await recap()).toBe('key-10');
    await pg.query(`UPDATE "Image" SET "tosViolation"=true WHERE id=10`);
    expect(await recap()).toBeNull();
  });

  // A hidden entry carries neither its image id nor its key, so entries are compared whole.
  const judged = async (playerId: number) =>
    (await listJudgments(db, playerId, { page: 1 })).judgments.map((j) => [j.imageId, j.imageKey]);

  it("hides it in a Knight's judgment history once it comes under a hold", async () => {
    await seedPlayer(pg, 1);
    const id = await skillCheck(10, '4');
    await answer(1, id, '16');
    expect(await judged(1)).toEqual([[10, 'key-10']]);
    await pg.query(`UPDATE "Image" SET "tosViolation"=true WHERE id=10`);
    expect(await judged(1)).toEqual([[null, null]]);
  });

  it("hides it in an Acolyte's judgment history once it comes under a hold", async () => {
    await seedPlayer(pg, 1, 'Acolyte');
    const check = await skillCheck(10, '4');
    await answerApprentice(
      db,
      { userId: 1, kind: 'rating', referenceId: check, answer: '4' },
      { now: () => NOW, skillCheckRate: 1 }
    );
    expect(await judged(1)).toEqual([[10, 'key-10']]);
    await pg.query(`UPDATE "Image" SET "tosViolation"=true WHERE id=10`);
    expect(await judged(1)).toEqual([[null, null]]);
  });

  it('keeps a mod-confirmed image out of the judgment history, and the rest in, when a safety check cannot be read', async () => {
    await seedPlayer(pg, 1);
    const check = await skillCheck(10, '4');
    const hidden = await hiddenRef(11);
    await answer(1, check, '4');
    await answer(1, hidden, '4');
    await pg.query(`ALTER TABLE "ImageFlag" RENAME TO "ImageFlagGone"`);
    try {
      const entries = await judged(1);
      expect(entries).toHaveLength(2);
      expect(entries).toEqual(
        expect.arrayContaining([
          [null, null],
          [11, 'key-11'],
        ])
      );
    } finally {
      await pg.query(`ALTER TABLE "ImageFlagGone" RENAME TO "ImageFlag"`);
    }
  });
});

describe('failing closed on serve', () => {
  it('serves no skill check, but still the hidden-check pool, when a safety check cannot be read', async () => {
    await seedPlayer(pg, 1);
    const check = await skillCheck(10);
    const hidden = await hiddenRef(11);
    await pg.query(`ALTER TABLE "ImageFlag" RENAME TO "ImageFlagGone"`);
    try {
      expect((await pick(1))?.referenceId).toBe(hidden);
      expect(await answer(1, check, '4')).toEqual({ status: 'rejected', reason: 'unavailable' });
    } finally {
      await pg.query(`ALTER TABLE "ImageFlagGone" RENAME TO "ImageFlag"`);
    }
  });

  it('serves an Acolyte something else when a safety check cannot be read', async () => {
    await seedPlayer(pg, 1, 'Acolyte');
    await seedImage(pg, 1);
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","explanation") VALUES (1,'trials','4','core','why')`
    );
    const check = await skillCheck(10);
    await pg.query(`ALTER TABLE "ImageFlag" RENAME TO "ImageFlagGone"`);
    try {
      const view = await getApprentice(db, 1, { skillCheckRate: 1 });
      expect(view.kind).toBe('question');
      expect(view.kind === 'question' && view.item.referenceId).toBe(1);
      expect(check).not.toBe(1);
    } finally {
      await pg.query(`ALTER TABLE "ImageFlagGone" RENAME TO "ImageFlag"`);
    }
  });
});

describe('one judgment per image for the other votes', () => {
  it('still refuses a queue rating on an image the player answered as a skill check, toggle on or off', async () => {
    await seedPlayer(pg, 1);
    const id = await skillCheck(10);
    await answer(1, id, '4', true);
    const itemId = await enqueueItem(db, { questionKey: Q, imageId: 10, source: 'test' }, NOW);
    expect(await castVote(db, { userId: 1, itemId, answer: '4' }, queueDeps)).toEqual({
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

  it('counts skill-check answers toward the accuracy window and the wrong-answer smite like any trial image', async () => {
    await seedPlayer(pg, 1, 'Acolyte');
    for (let id = 10; id < 16; id++) await skillCheck(id, '4');
    for (let i = 0; i < 6; i++) {
      const view = await getApprentice(db, 1, { skillCheckRate: 1 });
      expect(view.kind).toBe('question');
      if (view.kind !== 'question') return;
      expect(
        await answerApprentice(
          db,
          { userId: 1, kind: 'rating', referenceId: view.item.referenceId, answer: '16' },
          { now: () => NOW, skillCheckRate: 1 }
        )
      ).toMatchObject({ status: 'recorded', correct: false });
    }
    expect(await getApprenticeProgress(db, 1)).toMatchObject({
      graded: 6,
      correct: 0,
      accuracy: 0,
    });
    const smites = await pg.query(
      `SELECT reason FROM "NewOrderSmite" WHERE "targetPlayerId"=1 AND "cleansedAt" IS NULL`
    );
    expect(smites.rows).toEqual([{ reason: ACOLYTE_WRONG_ANSWER_SMITE }]);
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
