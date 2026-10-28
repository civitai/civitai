import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { TRIAL_MODULES, TRIALS } from './config';
import { planRun } from './plan';
import {
  answerTrial,
  getTrial,
  promoteToKnight,
  type TrialDeps,
  type TrialView,
} from './trials.service';

const T0 = new Date('2026-12-15T12:00:00Z');
const Q = TRIAL_MODULES[0];

let pg: PGlite;
let db: Kysely<DB>;
let now = T0;
let seeds: number[] = [];
const deps: TrialDeps = {
  now: () => now,
  newSeed: () => seeds.shift() ?? 1,
};

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsTrialAnswer","KnightsTrialRun","KnightsReferenceImage","NewOrderPlayer","Image","Post" RESTART IDENTITY CASCADE`
  );
  now = T0;
  seeds = [];
});

async function player(userId: number, rankType = 'Acolyte') {
  await pg.query(
    `INSERT INTO "NewOrderPlayer" ("userId","rankType","startAt") VALUES ($1,$2,'2020-01-01')`,
    [userId, rankType]
  );
}

async function reference(
  imageId: number,
  o: {
    source?: string;
    answer?: string;
    pool?: string;
    status?: string;
    explanation?: string;
    ingestion?: string;
  } = {}
) {
  await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,'2020-01-01')`, [imageId]);
  await pg.query(
    `INSERT INTO "Image" ("id","url","nsfwLevel","postId","ingestion") VALUES ($1,$2,4,$1,$3)`,
    [imageId, `key-${imageId}`, o.ingestion ?? 'Scanned']
  );
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","explanation","status")
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING "id"`,
    [
      imageId,
      o.pool ?? 'trials',
      o.answer ?? '4',
      o.source ?? 'harvested',
      o.explanation ?? (o.source === 'core' ? 'because' : null),
      o.status ?? 'active',
    ]
  );
  return rows[0].id;
}

async function standardPool() {
  await reference(1, { source: 'core', answer: '1', explanation: 'plainly safe' });
  await reference(2, { source: 'core', answer: '2' });
  for (const id of [11, 12, 13, 14]) await reference(id, { source: 'harvested', answer: '8' });
}

type Question = Extract<TrialView, { kind: 'question' }>;

async function current(userId: number): Promise<Question> {
  const view = await getTrial(db, userId, deps);
  if (view.kind !== 'question') throw new Error(`expected a question, got ${view.kind}`);
  return view;
}

const answerOf = async (referenceId: number) =>
  (
    await pg.query<{ answer: string }>(
      `SELECT "answer" FROM "KnightsReferenceImage" WHERE "id"=$1`,
      [referenceId]
    )
  ).rows[0].answer;

/** Plays the run out; `wrongOn` lists reference ids to answer wrongly. */
async function playOut(userId: number, wrongOn: number[] = []) {
  let last;
  for (let guard = 0; guard < 40; guard++) {
    const view = await getTrial(db, userId, deps);
    if (view.kind !== 'question') return last;
    const right = await answerOf(view.item.referenceId);
    const answer = wrongOn.includes(view.item.referenceId) ? (right === '16' ? '1' : '16') : right;
    last = await answerTrial(
      db,
      { questionKey: Q, userId, referenceId: view.item.referenceId, answer },
      deps
    );
  }
  throw new Error('run did not end');
}

const rank = async (userId: number) =>
  (
    await pg.query<{ rankType: string }>(
      `SELECT "rankType" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [userId]
    )
  ).rows[0]?.rankType;

describe('getTrial', () => {
  it('is for Acolytes only', async () => {
    await player(1, 'Knight');
    await standardPool();
    expect((await getTrial(db, 1, deps)).kind).toBe('not-acolyte');
    expect((await getTrial(db, 99, deps)).kind).toBe('not-acolyte');
  });

  it('has nothing to serve without enough fresh items, and starts no run', async () => {
    await player(1);
    await reference(1, { source: 'core' });
    await reference(11);
    expect((await getTrial(db, 1, deps)).kind).toBe('unavailable');
    expect((await pg.query(`SELECT 1 FROM "KnightsTrialRun"`)).rows).toHaveLength(0);
  });

  it('ignores retired items, hidden-check items and unservable images', async () => {
    await player(1);
    await reference(1, { source: 'core' });
    await reference(11, { status: 'retired' });
    await reference(12, { pool: 'hiddenCheck' });
    await reference(13, { ingestion: 'Blocked' });
    await reference(14);
    await reference(15);
    expect((await getTrial(db, 1, deps)).kind).toBe('unavailable');
  });

  it('opens with core and holds the seeded plan, without handing out any answer', async () => {
    await player(1);
    await standardPool();
    seeds = [4242];

    const view = await current(1);
    const run = (
      await pg.query<{ seed: number; itemIds: number[] }>(`SELECT * FROM "KnightsTrialRun"`)
    ).rows[0];

    expect(run.seed).toBe(4242);
    expect(run.itemIds).toHaveLength(6);
    expect(view.run).toEqual({ id: expect.any(Number), position: 1, total: 6 });
    const planned = planRun({
      seed: 4242,
      core: [1, 2],
      freshUnseen: [3, 4, 5, 6],
      length: TRIALS.runLength,
      freshCount: TRIALS.freshCount,
    });
    expect(run.itemIds).toEqual([...planned.core, ...planned.fresh]);
    expect([1, 2]).toContain(view.item.referenceId);
    expect(JSON.stringify(view)).not.toMatch(/answer|explanation|correct/i);
  });

  it('plans the same run from the same seed and another from another', async () => {
    await player(1);
    await player(2);
    await player(3);
    await standardPool();
    seeds = [9, 9, 10];
    await current(1);
    await current(2);
    await current(3);
    const plans = (
      await pg.query<{ itemIds: number[] }>(`SELECT "itemIds" FROM "KnightsTrialRun" ORDER BY "id"`)
    ).rows.map((r) => r.itemIds);
    expect(plans[1]).toEqual(plans[0]);
    expect(plans[2]).not.toEqual(plans[0]);
  });

  it('shows nothing to serve, and starts no scorable run, when too few fresh items are unseen', async () => {
    await player(1);
    await standardPool();
    seeds = [100, 200, 300];
    await playOut(1, [3, 4, 5, 6]);
    now = new Date(T0.getTime() + (TRIALS.cooldownHours + 1) * 3_600_000);
    const metBefore = (
      await pg.query<{ referenceId: number }>(`SELECT "referenceId" FROM "KnightsTrialAnswer"`)
    ).rows.map((r) => r.referenceId);

    await reference(21);
    await reference(22);
    expect((await getTrial(db, 1, deps)).kind).toBe('unavailable');
    expect((await pg.query(`SELECT 1 FROM "KnightsTrialRun"`)).rows).toHaveLength(1);

    await reference(23);
    await current(1);
    const second = (
      await pg.query<{ itemIds: number[] }>(`SELECT "itemIds" FROM "KnightsTrialRun" ORDER BY "id"`)
    ).rows[1].itemIds;
    const freshIds = [3, 4, 5, 6, 7, 8, 9];
    expect(second.filter((id) => freshIds.includes(id)).sort()).toEqual([7, 8, 9]);
    expect(second.filter((id) => metBefore.includes(id) && id > 2)).toEqual([]);
  });

  it('keeps one run open per player', async () => {
    await player(1);
    await standardPool();
    const first = await current(1);
    const second = await current(1);
    expect(second.run.id).toBe(first.run.id);
    expect((await pg.query(`SELECT 1 FROM "KnightsTrialRun"`)).rows).toHaveLength(1);
  });

  it('skips an item whose image went away mid-run', async () => {
    await player(1);
    await standardPool();
    const first = await current(1);
    await pg.query(
      `UPDATE "Image" SET "ingestion"='Blocked' WHERE "id"=(SELECT "imageId" FROM "KnightsReferenceImage" WHERE "id"=$1)`,
      [first.item.referenceId]
    );
    const next = await current(1);
    expect(next.item.referenceId).not.toBe(first.item.referenceId);
  });
});

describe('answerTrial', () => {
  it('shows the right answer after the pick, with the explanation for core items', async () => {
    await player(1);
    await standardPool();
    const view = await current(1);
    const answer = await answerOf(view.item.referenceId);

    const wrong = await answerTrial(
      db,
      {
        questionKey: Q,
        userId: 1,
        referenceId: view.item.referenceId,
        answer: answer === '16' ? '1' : '16',
      },
      deps
    );
    expect(wrong).toMatchObject({ status: 'recorded', correct: false, correctAnswer: answer });
    if (wrong.status !== 'recorded') throw new Error('unreachable');
    expect(wrong.explanation).toBe(view.item.referenceId === 1 ? 'plainly safe' : 'because');
    expect(wrong.correctLabel).toBeTruthy();
  });

  it('counts answers and failures per item', async () => {
    await player(1);
    await player(2);
    await standardPool();
    seeds = [5, 5];
    const a = await current(1);
    const b = await current(2);
    expect(b.item.referenceId).toBe(a.item.referenceId);
    const right = await answerOf(a.item.referenceId);
    await answerTrial(
      db,
      { questionKey: Q, userId: 1, referenceId: a.item.referenceId, answer: right },
      deps
    );
    await answerTrial(
      db,
      {
        questionKey: Q,
        userId: 2,
        referenceId: a.item.referenceId,
        answer: right === '16' ? '1' : '16',
      },
      deps
    );
    const row = (
      await pg.query<{ answers: number; failures: number }>(
        `SELECT "answers","failures" FROM "KnightsReferenceImage" WHERE "id"=$1`,
        [a.item.referenceId]
      )
    ).rows[0];
    expect(row).toEqual({ answers: 2, failures: 1 });
  });

  it('refuses an item that is not the current one, a repeat, or an option not on offer', async () => {
    await player(1);
    await standardPool();
    const view = await current(1);
    const other = [1, 2, 3, 4, 5, 6].find((id) => id !== view.item.referenceId)!;

    expect(
      await answerTrial(db, { questionKey: Q, userId: 1, referenceId: other, answer: '4' }, deps)
    ).toEqual({
      status: 'rejected',
      reason: 'not-current',
    });
    expect(
      await answerTrial(
        db,
        { questionKey: Q, userId: 1, referenceId: view.item.referenceId, answer: '3' },
        deps
      )
    ).toEqual({ status: 'rejected', reason: 'bad-answer' });
    await answerTrial(
      db,
      { questionKey: Q, userId: 1, referenceId: view.item.referenceId, answer: '4' },
      deps
    );
    expect(
      await answerTrial(
        db,
        { questionKey: Q, userId: 1, referenceId: view.item.referenceId, answer: '4' },
        deps
      )
    ).toEqual({ status: 'rejected', reason: 'not-current' });
    expect(
      await answerTrial(db, { questionKey: Q, userId: 2, referenceId: 1, answer: '4' }, deps)
    ).toEqual({
      status: 'rejected',
      reason: 'no-run',
    });
  });
});

describe('graduation', () => {
  it('promotes a player who passes on fresh items, whatever they did on core', async () => {
    await player(1);
    await standardPool();
    const result = await playOut(1, [1, 2]);

    expect(result).toMatchObject({ status: 'recorded', finished: { result: 'passed', score: 1 } });
    expect(await rank(1)).toBe('Knight');
    const run = (
      await pg.query<{ result: string; finishedAt: Date | null }>(`SELECT * FROM "KnightsTrialRun"`)
    ).rows[0];
    expect(run.result).toBe('passed');
    expect(run.finishedAt).not.toBeNull();
    expect((await getTrial(db, 1, deps)).kind).toBe('not-acolyte');
  });

  it('keeps a player who misses the mark an Acolyte and holds a cooldown', async () => {
    await player(1);
    await standardPool();
    const fresh = [3, 4, 5, 6];
    const result = await playOut(1, fresh.slice(0, 2));

    expect(result).toMatchObject({ finished: { result: 'failed', score: 0.5 } });
    expect(await rank(1)).toBe('Acolyte');
    const view = await getTrial(db, 1, deps);
    expect(view).toEqual({
      kind: 'cooldown',
      until: new Date(T0.getTime() + TRIALS.cooldownHours * 3_600_000),
    });
  });

  it('starts a new run with a new seed once the cooldown is over, on items not met yet first', async () => {
    await player(1);
    await standardPool();
    for (const id of [21, 22, 23, 24, 25, 26, 27, 28]) await reference(id, { answer: '8' });
    seeds = [100, 200];
    await playOut(1, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const firstRun = (
      await pg.query<{ itemIds: number[] }>(`SELECT "itemIds" FROM "KnightsTrialRun"`)
    ).rows[0].itemIds;

    now = new Date(T0.getTime() + (TRIALS.cooldownHours + 1) * 3_600_000);
    const view = await current(1);

    const runs = (
      await pg.query<{ seed: number; itemIds: number[] }>(
        `SELECT * FROM "KnightsTrialRun" ORDER BY "id"`
      )
    ).rows;
    expect(runs.map((r) => r.seed)).toEqual([100, 200]);
    const unmet = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].filter((id) => !firstRun.includes(id));
    expect(unmet).toHaveLength(4);
    expect(runs[1].itemIds).toEqual(expect.arrayContaining(unmet));
    expect(view.run.position).toBe(1);
  });
});

describe('a run too thin to decide', () => {
  it('closes void with no cooldown when too few fresh items could be answered, and starts afresh', async () => {
    await player(1);
    await standardPool();
    seeds = [1, 2];
    for (let i = 0; i < 4; i++) {
      const view = await current(1);
      await answerTrial(
        db,
        { questionKey: Q, userId: 1, referenceId: view.item.referenceId, answer: '4' },
        deps
      );
    }
    await pg.query(
      `UPDATE "Image" SET "ingestion"='Blocked' WHERE "id" IN (
         SELECT "imageId" FROM "KnightsReferenceImage" r
         WHERE "source"<>'core' AND NOT EXISTS (SELECT 1 FROM "KnightsTrialAnswer" a WHERE a."referenceId"=r."id"))`
    );
    for (const id of [21, 22, 23, 24]) await reference(id);

    const view = await current(1);

    const runs = (
      await pg.query<{
        id: number;
        result: string | null;
        score: number | null;
        cooldownUntil: Date | null;
      }>(`SELECT "id","result","score","cooldownUntil" FROM "KnightsTrialRun" ORDER BY "id"`)
    ).rows;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ result: 'void', score: null, cooldownUntil: null });
    expect(view.run.id).toBe(runs[1].id);
    expect(await rank(1)).toBe('Acolyte');
  });
});

describe('a demoted player', () => {
  it('is not promoted again by a pass from before the reset', async () => {
    await player(1);
    await standardPool();
    for (const id of [21, 22, 23, 24, 25, 26, 27, 28]) await reference(id, { answer: '8' });
    await playOut(1);
    expect(await rank(1)).toBe('Knight');

    await pg.query(
      `UPDATE "NewOrderPlayer" SET "rankType"='Acolyte', "startAt"=$1 WHERE "userId"=1`,
      [new Date(T0.getTime() + 60_000).toISOString()]
    );
    now = new Date(T0.getTime() + 3_600_000);

    expect((await getTrial(db, 1, deps)).kind).toBe('question');
    expect(await rank(1)).toBe('Acolyte');
  });
});

describe('answerTrial with several open runs', () => {
  it('answers the run of the module asked about', async () => {
    await player(1);
    await pg.query(
      `INSERT INTO "KnightsTrialRun" ("playerId","questionKey","seed","itemIds") VALUES (1,'other.module',1,'[]')`
    );
    await standardPool();
    const view = await current(1);

    expect(
      await answerTrial(
        db,
        { questionKey: Q, userId: 1, referenceId: view.item.referenceId, answer: '4' },
        deps
      )
    ).toMatchObject({ status: 'recorded' });
    expect(
      await answerTrial(
        db,
        { questionKey: 'missing.module', userId: 1, referenceId: 1, answer: '4' },
        deps
      )
    ).toEqual({ status: 'rejected', reason: 'no-run' });
  });
});

describe('promoteToKnight', () => {
  it('creates the player row when missing and never lowers a higher rank', async () => {
    await promoteToKnight(db, 5);
    expect(await rank(5)).toBe('Knight');
    await player(6, 'Templar');
    await promoteToKnight(db, 6);
    expect(await rank(6)).toBe('Templar');
  });
});
