import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { getLevelProgression } from '../progression/levels';
import { counterValue } from '../../../test/metrics';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
import { expForLevel } from '../progression/levels';
import {
  acknowledgeCheckpoint,
  answerApprentice,
  getApprentice,
  type ApprenticeDeps,
  type ApprenticeItem,
  type ApprenticeView,
} from './apprenticeship.service';

const T0 = new Date('2026-12-25T12:00:00Z');
const YESNO_Q = 'knights.yesno.violence';

vi.mock('../axiom', () => ({ logToAxiom: vi.fn() }));

let pg: PGlite;
let db: Kysely<DB>;
let now = T0;
const mirrorXp = vi.fn(async () => undefined);
const deps = (): ApprenticeDeps => ({ now: () => now, mirrorXp });

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsApprenticeAnswer","KnightsYesNoReference","KnightsReferenceImage","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
  );
  await pg.exec(`DELETE FROM "KnightsQuestion" WHERE "key" LIKE 'knights.yesno.%'`);
  await pg.query(
    `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ($1,'bool','Does this show violence?','[]')`,
    [YESNO_Q]
  );
  now = T0;
  mirrorXp.mockClear();
});

async function player(userId: number, o: { rank?: string; exp?: number; startAt?: string } = {}) {
  await pg.query(
    `INSERT INTO "NewOrderPlayer" ("userId","rankType","exp","startAt") VALUES ($1,$2,$3,$4)`,
    [userId, o.rank ?? 'Acolyte', o.exp ?? 0, o.startAt ?? '2020-01-01']
  );
}

async function rating(
  imageId: number,
  o: { source?: string; answer?: string; status?: string; pool?: string; explanation?: string } = {}
) {
  await seedImage(pg, imageId);
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","explanation","status")
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING "id"`,
    [
      imageId,
      o.pool ?? 'trials',
      o.answer ?? '4',
      o.source ?? 'harvested',
      o.explanation ?? null,
      o.status ?? 'active',
    ]
  );
  return rows[0].id;
}

async function yesNo(
  imageId: number,
  o: { answer?: boolean; active?: boolean; explanation?: string; prompt?: string } = {}
) {
  await seedImage(pg, imageId);
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsYesNoReference" ("imageId","questionKey","answer","explanation","active","createdBy","prompt")
     VALUES ($1,$2,$3,$4,$5,1,$6) RETURNING "id"`,
    [imageId, YESNO_Q, o.answer ?? true, o.explanation ?? null, o.active ?? true, o.prompt ?? null]
  );
  return rows[0].id;
}

/** `count` already-answered references for a player, oldest first, `correct` of them right. */
async function history(userId: number, flags: boolean[]) {
  const base = 500000 + userId * 10000;
  for (const [index, correct] of flags.entries()) {
    const id = await rating(base + index, { answer: '4' });
    await pg.query(
      `INSERT INTO "KnightsApprenticeAnswer" ("playerId","referenceId","answer","correctAnswer","correct","xp","createdAt")
       VALUES ($1,$2,$3,'4',$4,0,$5)`,
      [userId, id, correct ? '4' : '1', correct, new Date(T0.getTime() - 86_400_000 + index * 1000)]
    );
  }
}

const rows = (n: number, correct: number) =>
  Array.from({ length: n }, (_, i) => i < n - correct).map((wrong) => !wrong);

function question(
  view: ApprenticeView
): { item: ApprenticeItem } & Extract<ApprenticeView, { kind: 'question' }> {
  if (view.kind !== 'question') throw new Error(`expected a question, got ${view.kind}`);
  return view;
}

async function correctFor(item: ApprenticeItem): Promise<string> {
  if (item.kind === 'yesno') {
    const { rows } = await pg.query<{ answer: boolean }>(
      `SELECT "answer" FROM "KnightsYesNoReference" WHERE "id"=$1`,
      [item.referenceId]
    );
    return rows[0].answer ? 'yes' : 'no';
  }
  const { rows } = await pg.query<{ answer: string }>(
    `SELECT "answer" FROM "KnightsReferenceImage" WHERE "id"=$1`,
    [item.referenceId]
  );
  return rows[0].answer;
}

const wrongFor = async (item: ApprenticeItem) => {
  const right = await correctFor(item);
  return item.kind === 'yesno' ? (right === 'yes' ? 'no' : 'yes') : right === '32' ? '1' : '32';
};

/** Answers whatever is next; `right` decides per position whether to answer correctly. */
async function answerNext(userId: number, right: boolean | ((n: number) => boolean) = true, n = 0) {
  const { item } = question(await getApprentice(db, userId));
  const isRight = typeof right === 'function' ? right(n) : right;
  const result = await answerApprentice(
    db,
    {
      userId,
      kind: item.kind,
      referenceId: item.referenceId,
      version: item.version,
      answer: isRight ? await correctFor(item) : await wrongFor(item),
    },
    deps()
  );
  now = new Date(now.getTime() + 1000);
  return { item, result };
}

/** Plays `count` answers, moving past each checkpoint recap as a player would. */
async function play(
  userId: number,
  count: number,
  right: boolean | ((n: number) => boolean) = true
) {
  const served: ApprenticeItem[] = [];
  for (let n = 0; n < count; n++) {
    if ((await getApprentice(db, userId)).kind === 'checkpoint')
      await acknowledgeCheckpoint(db, userId, now);
    const { item } = await answerNext(userId, right, n);
    served.push(item);
  }
  return served;
}

const expOf = async (userId: number) =>
  (
    await pg.query<{ exp: number }>(`SELECT "exp" FROM "NewOrderPlayer" WHERE "userId"=$1`, [
      userId,
    ])
  ).rows[0].exp;
const rankOf = async (userId: number) =>
  (
    await pg.query<{ rankType: string }>(
      `SELECT "rankType" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [userId]
    )
  ).rows[0].rankType;

describe('the stream', () => {
  it('serves the curated core first, then mixes yes/no with harvested images, and never repeats an item', async () => {
    await player(1);
    const core = [
      await rating(1, { source: 'core', explanation: 'x' }),
      await rating(2, { source: 'core', explanation: 'x' }),
    ];
    for (let i = 0; i < 4; i++) await rating(10 + i);
    for (let i = 0; i < 2; i++) await yesNo(20 + i);

    const served = await play(1, 8);

    expect(
      served
        .slice(0, 2)
        .map((s) => s.referenceId)
        .sort()
    ).toEqual([...core].sort());
    expect(served.slice(0, 2).every((s) => s.kind === 'rating')).toBe(true);
    const rest = served.slice(2);
    // The rhythm follows the player's answer count, so it carries on from the two core answers.
    expect(rest.map((s) => s.kind)).toEqual([
      'yesno',
      'rating',
      'rating',
      'yesno',
      'rating',
      'rating',
    ]);
    const keys = served.map((s) => `${s.kind}:${s.referenceId}`);
    expect(new Set(keys).size).toBe(8);
    // 8 answered, nothing left: the recap is not due yet, so the stream simply has no more items.
    expect((await getApprentice(db, 1)).kind).toBe('exhausted');
  });

  it('shows a friendly out-of-items state, not an error, once everything has been answered', async () => {
    await player(1);
    await rating(1);
    await yesNo(2);
    await play(1, 2);
    const view = await getApprentice(db, 1);
    expect(view.kind).toBe('exhausted');
  });

  it('is the same item until it is answered', async () => {
    await player(1);
    for (let i = 0; i < 5; i++) await rating(i + 1);
    const a = question(await getApprentice(db, 1)).item;
    const b = question(await getApprentice(db, 1)).item;
    expect(b).toEqual(a);
  });

  it('skips retired and held references, inactive pairs, unservable images', async () => {
    await player(1);
    await rating(1, { status: 'retired' });
    await rating(2, { status: 'pending' });
    await rating(3, { pool: 'hiddenCheck' });
    await yesNo(4, { active: false });
    const blocked = await rating(5);
    await pg.query(`UPDATE "Image" SET "ingestion"='Blocked' WHERE "id"=5`);
    const good = await rating(7);

    const { item } = question(await getApprentice(db, 1));
    expect(blocked).toBeGreaterThan(0);
    expect(item.referenceId).toBe(good);
  });

  it('is for Acolytes only', async () => {
    await player(1, { rank: 'Knight' });
    await rating(1);
    expect((await getApprentice(db, 1)).kind).toBe('not-acolyte');
  });
});

describe('grading and XP', () => {
  it('pays 100 XP for a right rating and nothing for a wrong one, and records the graded answer', async () => {
    await player(1);
    const wrongOne = await rating(1, { answer: '8', source: 'core', explanation: 'adult themes' });
    const rightOne = await rating(2, { answer: '2', source: 'core', explanation: 'mild' });

    const first = await answerNext(1, false);
    const second = await answerNext(1, true);

    expect(first.result).toMatchObject({ status: 'recorded', correct: false, xp: 0 });
    expect(second.result).toMatchObject({ status: 'recorded', correct: true, xp: 100 });
    expect(await expOf(1)).toBe(100);
    expect(mirrorXp).toHaveBeenCalledTimes(1);
    expect(mirrorXp).toHaveBeenCalledWith([{ playerId: 1, xp: 100 }]);
    const stored = await pg.query<{
      referenceId: number;
      correct: boolean;
      xp: number;
      correctAnswer: string;
    }>(
      `SELECT "referenceId","correct","xp","correctAnswer" FROM "KnightsApprenticeAnswer" ORDER BY "id"`
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.map((r) => [r.correct, r.xp])).toEqual([
      [false, 0],
      [true, 100],
    ]);
    expect([first.item.referenceId, second.item.referenceId].sort()).toEqual(
      [wrongOne, rightOne].sort()
    );
    const counters = await pg.query<{ answers: number; failures: number }>(
      `SELECT "answers","failures" FROM "KnightsReferenceImage" WHERE "id"=$1`,
      [first.item.referenceId]
    );
    expect(counters.rows[0]).toEqual({ answers: 1, failures: 1 });
  });

  it('grades a yes/no answer against the curated boolean', async () => {
    await player(1);
    await yesNo(1, { answer: false, explanation: 'No weapon is shown' });

    const wrong = await answerNext(1, false);
    expect(wrong.result).toMatchObject({ correct: false, xp: 0 });
    expect(await expOf(1)).toBe(0);
    const stored = await pg.query<{ answer: string; correctAnswer: string }>(
      `SELECT "answer","correctAnswer" FROM "KnightsApprenticeAnswer"`
    );
    expect(stored.rows[0]).toEqual({ answer: 'yes', correctAnswer: 'no' });
  });

  it("shows a yes/no pair's own question, and the axis question for a pair without one", async () => {
    await player(1);
    await yesNo(1, { prompt: 'Is a knife held in the hand?' });
    await yesNo(2);

    const served = await play(1, 2);
    const promptOf = async (referenceId: number) =>
      served.find((s) => s.referenceId === referenceId)?.prompt;
    const ids = (
      await pg.query<{ id: number; imageId: number }>(
        `SELECT "id","imageId" FROM "KnightsYesNoReference" ORDER BY "imageId"`
      )
    ).rows;
    expect(await promptOf(ids[0].id)).toBe('Is a knife held in the hand?');
    expect(await promptOf(ids[1].id)).toBe('Does this show violence?');
  });

  it('grades a yes/no answer only against the pair the player was shown', async () => {
    await player(1);
    await player(2);
    const id = await yesNo(1, { answer: true, prompt: 'Is a knife held?' });
    const shown = question(await getApprentice(db, 1)).item;
    const alsoShown = question(await getApprentice(db, 2)).item;
    expect(shown.version).toEqual(expect.any(String));

    await pg.query(
      `UPDATE "KnightsYesNoReference" SET "answer"=false, "prompt"='Is a sword held?', "updatedAt"="updatedAt" + interval '1 second' WHERE "id"=$1`,
      [id]
    );
    const stale = await answerApprentice(
      db,
      { userId: 1, kind: 'yesno', referenceId: id, version: shown.version, answer: 'yes' },
      deps()
    );

    expect(stale).toEqual({ status: 'rejected', reason: 'not-current' });
    expect((await pg.query(`SELECT 1 FROM "KnightsApprenticeAnswer"`)).rows).toHaveLength(0);
    expect(await expOf(1)).toBe(0);

    const refreshed = question(await getApprentice(db, 1)).item;
    expect(refreshed.version).not.toBe(shown.version);
    expect(refreshed.prompt).toBe('Is a sword held?');
    const fresh = await answerApprentice(
      db,
      { userId: 1, kind: 'yesno', referenceId: id, version: refreshed.version, answer: 'no' },
      deps()
    );
    expect(fresh).toMatchObject({ status: 'recorded', correct: true });

    const stored = await pg.query<{ correctAnswer: string }>(
      `SELECT "correctAnswer" FROM "KnightsApprenticeAnswer"`
    );
    expect(stored.rows).toEqual([{ correctAnswer: 'no' }]);
    expect(alsoShown.version).toBe(shown.version);
  });

  it('refuses a yes/no answer that carries no version', async () => {
    await player(1);
    const id = await yesNo(1);
    const result = await answerApprentice(
      db,
      { userId: 1, kind: 'yesno', referenceId: id, answer: 'yes' },
      deps()
    );
    expect(result).toEqual({ status: 'rejected', reason: 'not-current' });
  });

  it('never smites an Acolyte for wrong answers', async () => {
    await player(1);
    for (let i = 0; i < 6; i++) await rating(i + 1);
    await play(1, 6, false);
    const smites = await pg.query(`SELECT 1 FROM "NewOrderSmite"`);
    expect(smites.rows).toHaveLength(0);
    expect(await expOf(1)).toBe(0);
    expect(await rankOf(1)).toBe('Acolyte');
  });

  it('refuses an item that is not the current one, an answer that is not on offer, and a Knight, writing nothing', async () => {
    await player(1);
    await player(2, { rank: 'Knight' });
    for (let i = 0; i < 4; i++) await rating(i + 1);
    const { item } = question(await getApprentice(db, 1));
    const other = [1, 2, 3, 4].find((id) => id !== item.referenceId)!;

    const stale = await answerApprentice(
      db,
      { userId: 1, kind: 'rating', referenceId: other, answer: '4' },
      deps()
    );
    const odd = await answerApprentice(
      db,
      { userId: 1, kind: 'rating', referenceId: item.referenceId, answer: 'maybe' },
      deps()
    );
    const wrongKind = await answerApprentice(
      db,
      { userId: 1, kind: 'yesno', referenceId: item.referenceId, answer: 'yes' },
      deps()
    );
    const knight = await answerApprentice(
      db,
      { userId: 2, kind: 'rating', referenceId: item.referenceId, answer: '4' },
      deps()
    );
    const stranger = await answerApprentice(
      db,
      { userId: 99, kind: 'rating', referenceId: item.referenceId, answer: '4' },
      deps()
    );

    expect(stale).toEqual({ status: 'rejected', reason: 'not-current' });
    expect(odd).toEqual({ status: 'rejected', reason: 'bad-answer' });
    expect(wrongKind).toEqual({ status: 'rejected', reason: 'not-current' });
    expect(knight).toEqual({ status: 'rejected', reason: 'not-acolyte' });
    expect(stranger).toEqual({ status: 'rejected', reason: 'no-player' });
    expect((await pg.query(`SELECT 1 FROM "KnightsApprenticeAnswer"`)).rows).toHaveLength(0);
    expect(await expOf(1)).toBe(0);
  });
});

describe('accuracy', () => {
  it('reads only the last 100 answers', async () => {
    await player(1);
    for (let i = 0; i < 3; i++) await rating(i + 1);
    // 50 old wrong answers followed by 100 right ones: the window is all right.
    await history(1, [...rows(50, 0), ...rows(100, 100)]);
    const view = await getApprentice(db, 1);
    const progress = 'progress' in view ? view.progress : null;
    expect(progress).toMatchObject({ graded: 100, correct: 100, accuracy: 1 });
    expect(progress?.answered).toBe(150);
  });

  it('counts every answer while there are fewer than 100', async () => {
    await player(1);
    await rating(1);
    await history(1, rows(8, 6));
    const view = await getApprentice(db, 1);
    expect('progress' in view && view.progress).toMatchObject({
      graded: 8,
      correct: 6,
      accuracy: 0.75,
    });
  });

  it('ignores answers from before a career reset, but still never repeats their items', async () => {
    await player(1, { startAt: '2026-12-25 00:00:00' });
    const only = await rating(1);
    await history(1, rows(30, 0));
    const view = await getApprentice(db, 1);
    expect('progress' in view && view.progress).toMatchObject({
      graded: 0,
      answered: 0,
      accuracy: null,
    });
    expect(question(view).item.referenceId).toBe(only);
  });
});

describe('promotion', () => {
  // The exp that is exactly one right answer short of level 20.
  const justShort = () => expForLevel(20) - 100;

  it('knights a player whose 100th-to-last window reaches the bar on the answer that reaches level 20', async () => {
    await player(1, { exp: justShort() });
    await rating(1);
    await history(1, rows(99, 74));
    const before = await counterValue('knights_rank_ups_total', { rank: 'Knight' });

    const { result } = await answerNext(1, true);

    expect(result).toMatchObject({ status: 'recorded', correct: true, promoted: true });
    expect(await rankOf(1)).toBe('Knight');
    expect(getLevelProgression(await expOf(1)).level).toBe(20);
    expect(await counterValue('knights_rank_ups_total', { rank: 'Knight' })).toBe(before + 1);
  });

  it('keeps an Acolyte below the bar at level 20 playing, with nothing reset, until accuracy recovers', async () => {
    await player(1, { exp: justShort() });
    for (let i = 0; i < 40; i++) await rating(i + 1);
    await history(1, rows(99, 72));

    const reached = await answerNext(1, true);
    expect(reached.result).toMatchObject({ correct: true, promoted: false });
    expect(await rankOf(1)).toBe('Acolyte');
    const exp = await expOf(1);
    expect(getLevelProgression(exp).level).toBe(20);

    // 73 of the last 100 so far; every right answer replaces an older wrong one in the window until 75 is reached.
    let promoted = false;
    for (let guard = 0; guard < 30 && !promoted; guard++) {
      if ((await getApprentice(db, 1)).kind === 'checkpoint')
        await acknowledgeCheckpoint(db, 1, now);
      const { result } = await answerNext(1, true);
      promoted = result.status === 'recorded' && result.promoted;
    }
    expect(promoted).toBe(true);
    expect(await rankOf(1)).toBe('Knight');
    expect(await expOf(1)).toBeGreaterThan(exp);
  });

  it('does not knight a player at the bar who has not reached level 20', async () => {
    await player(1, { exp: expForLevel(10) });
    await rating(1);
    await history(1, rows(99, 99));
    const { result } = await answerNext(1, true);
    expect(result).toMatchObject({ promoted: false });
    expect(await rankOf(1)).toBe('Acolyte');
  });

  it('does not knight on a wrong answer that leaves the window under the bar', async () => {
    await player(1, { exp: expForLevel(20) });
    await rating(1);
    await history(1, rows(99, 74));
    const { result } = await answerNext(1, false);
    expect(result).toMatchObject({ correct: false, promoted: false });
    expect(await rankOf(1)).toBe('Acolyte');
  });
});

describe('checkpoints', () => {
  it('closes every 20 answers with a recap that counts and lists the same 20 answers', async () => {
    await player(1);
    for (let i = 0; i < 30; i++) await rating(i + 1, { answer: '2', explanation: `why ${i + 1}` });
    // Right except on answers 3, 8 and 15 of the first twenty.
    const missed = new Set([3, 8, 15]);
    const served = await play(1, 20, (n) => !missed.has(n + 1));

    const view = await getApprentice(db, 1);
    expect(view.kind).toBe('checkpoint');
    if (view.kind !== 'checkpoint') return;
    expect(view.checkpoint.total).toBe(20);
    expect(view.checkpoint.right).toBe(17);
    expect(view.checkpoint.missed).toHaveLength(3);
    // Answer ids follow the order given (the identity sequence restarts per test).
    expect(view.checkpoint.missed.map((m) => m.answerId)).toEqual([3, 8, 15]);
    expect(view.checkpoint.missed[0]).toMatchObject({
      kind: 'rating',
      answerLabel: expect.any(String),
      correctLabel: 'PG-13',
      explanation: `why ${served[2].referenceId}`,
    });
    expect(view.checkpoint.missed[0].answerLabel).not.toBe('PG-13');
    expect(view.checkpoint.coach).toBe(false);
    expect(view.progress.accuracy).toBe(0.85);
  });

  it('holds the next item back until the player continues, and then resumes', async () => {
    await player(1);
    for (let i = 0; i < 25; i++) await rating(i + 1);
    await play(1, 20);

    const blocked = await answerApprentice(
      db,
      { userId: 1, kind: 'rating', referenceId: 1, answer: '4' },
      deps()
    );
    expect(blocked).toEqual({ status: 'rejected', reason: 'checkpoint-pending' });
    // A reload still shows the same recap.
    expect((await getApprentice(db, 1)).kind).toBe('checkpoint');

    await acknowledgeCheckpoint(db, 1, now);
    await acknowledgeCheckpoint(db, 1, now);
    expect(question(await getApprentice(db, 1))).toBeTruthy();
    await answerNext(1);
    expect((await getApprentice(db, 1)).kind).toBe('question');
  });

  it('shows only the latest 20 at the next checkpoint', async () => {
    await player(1);
    for (let i = 0; i < 45; i++) await rating(i + 1, { answer: '2' });
    await play(1, 20, false);
    await play(1, 20, true);
    const view = await getApprentice(db, 1);
    if (view.kind !== 'checkpoint') throw new Error('expected a checkpoint');
    expect(view.checkpoint).toMatchObject({ total: 20, right: 20, missed: [] });
    expect(view.progress.answered).toBe(40);
    expect(view.progress.accuracy).toBe(0.5);
  });

  it('lists a missed yes/no answer with its curated explanation', async () => {
    await player(1);
    await yesNo(1, { answer: true, explanation: 'A weapon is raised' });
    for (let i = 0; i < 19; i++) await rating(100 + i);
    await play(1, 20, false);
    const view = await getApprentice(db, 1);
    if (view.kind !== 'checkpoint') throw new Error('expected a checkpoint');
    const yn = view.checkpoint.missed.find((m) => m.kind === 'yesno');
    expect(yn).toMatchObject({
      answerLabel: 'No',
      correctLabel: 'Yes',
      explanation: 'A weapon is raised',
    });
  });

  it('offers coaching once accuracy is under 60% after 50 answers, and not before', async () => {
    await player(1);
    for (let i = 0; i < 70; i++) await rating(i + 1, { answer: '2' });
    await play(1, 40, (n) => n % 2 === 0);
    const early = await getApprentice(db, 1);
    expect(early.kind === 'checkpoint' && early.checkpoint.coach).toBe(false);

    await play(1, 20, (n) => n % 2 === 0);
    const later = await getApprentice(db, 1);
    expect(later.kind === 'checkpoint' && later.checkpoint.coach).toBe(true);
  });
});

describe('answers outlive their reference', () => {
  const answerRows = async () =>
    (
      await pg.query<{
        referenceId: number | null;
        yesNoReferenceId: number | null;
        imageId: number | null;
        questionKey: string | null;
      }>(
        `SELECT "referenceId","yesNoReferenceId","imageId","questionKey" FROM "KnightsApprenticeAnswer" ORDER BY "id"`
      )
    ).rows;

  it('records the image and question each answer was given for', async () => {
    await player(1);
    await rating(1, { source: 'core' });
    await yesNo(2);
    await play(1, 2);
    const stored = await answerRows();
    expect(stored.map((r) => [r.imageId, r.questionKey])).toEqual([
      [1, 'knights.image.nsfwLevel'],
      [2, YESNO_Q],
    ]);
  });

  it('keeps counting, and never re-serves, an answer whose yes/no pair was deleted', async () => {
    await player(1);
    const pair = await yesNo(1);
    await rating(2);
    await play(1, 2);
    await pg.query(`DELETE FROM "KnightsYesNoReference" WHERE "id"=$1`, [pair]);
    await pg.query(
      `INSERT INTO "KnightsYesNoReference" ("imageId","questionKey","answer","createdBy") VALUES (1,$1,true,1)`,
      [YESNO_Q]
    );
    await rating(3);

    expect((await answerRows()).map((r) => r.yesNoReferenceId)).toEqual([null, null]);
    const view = question(await getApprentice(db, 1));
    expect(view.progress).toMatchObject({ answered: 2, graded: 2 });
    expect(view.item.kind).toBe('rating');
    expect(view.item.referenceId).not.toBe(pair);
    await answerNext(1);
    expect((await getApprentice(db, 1)).kind).toBe('exhausted');
  });

  it('keeps the answer when the image of a yes/no pair is deleted, and the checkpoint does not move', async () => {
    await player(1);
    for (let i = 0; i < 10; i++) await yesNo(i + 1, { answer: true, explanation: `why ${i + 1}` });
    for (let i = 0; i < 20; i++) await rating(100 + i, { answer: '2' });
    // Miss the first yes/no pair served, whichever the player's order puts first.
    let missed: ApprenticeItem | null = null;
    for (let n = 0; n < 20; n++) {
      if ((await getApprentice(db, 1)).kind === 'checkpoint')
        await acknowledgeCheckpoint(db, 1, now);
      const { item } = question(await getApprentice(db, 1));
      const miss = item.kind === 'yesno' && missed === null;
      if (miss) missed = item;
      await answerNext(1, !miss);
    }
    if (!missed) throw new Error('no yes/no pair was served');
    // Pair n was seeded on image n.
    await pg.query(`DELETE FROM "Image" WHERE "id"=$1`, [missed.referenceId]);

    expect((await answerRows()).filter((r) => r.imageId === missed!.referenceId)).toEqual([
      expect.objectContaining({ yesNoReferenceId: null, questionKey: YESNO_Q }),
    ]);
    const view = await getApprentice(db, 1);
    if (view.kind !== 'checkpoint') throw new Error('expected a checkpoint');
    expect(view.progress.answered).toBe(20);
    expect(view.checkpoint).toMatchObject({ total: 20, right: 19 });
    expect(view.checkpoint.missed).toEqual([
      expect.objectContaining({
        kind: 'yesno',
        imageKey: null,
        answerLabel: 'No',
        correctLabel: 'Yes',
        explanation: null,
      }),
    ]);
  });
});
