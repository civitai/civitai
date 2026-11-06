import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { YESNO_QUESTION_MAX } from '@civitai/db/knights';
import { YESNO_PROMPT_MAX } from '../../../knights/trials-limits';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../../db', () => ({
  get dbRead() {
    throw new Error('the question manager must read from the primary, not the replica');
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const {
  getYesNoAxes,
  getYesNoQuestionItems,
  retireYesNoQuestion,
  rewordYesNoQuestion,
  unretireYesNoQuestion,
} = await import('../yesno-question.service');

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations'
);
const NOW = new Date('2026-12-27T12:00:00Z');
const MOD = 4;
const AXIS = 'knights.yesno.violence';
const OTHER_AXIS = 'knights.yesno.profanity';

let db: PGlite;

async function seedItem(
  id: number,
  o: {
    imageId?: number;
    axis?: string;
    prompt?: string;
    status?: string;
    reason?: string | null;
    voteCount?: number;
    audience?: string | null;
    externalId?: string;
  } = {}
) {
  const imageId = o.imageId ?? 1;
  await db.query(
    `INSERT INTO "KnightsQueueItem" ("id","questionKey","imageId","source","minRank","votesNeeded","priority","status","reason","audience","prompt","externalId","voteCount","yesEffect","noEffect","meta")
     VALUES ($1,$2,$3,'yesno-import','Knight',4,2,$4,$5,$6,$7,$8,$9,'R4','R3','{"caseId":"c"}')`,
    [
      id,
      o.axis ?? AXIS,
      imageId,
      o.status ?? 'Open',
      o.reason ?? null,
      o.audience === undefined ? 'players' : o.audience,
      o.prompt ?? `Question ${id}?`,
      o.externalId ?? `ext-${id}`,
      o.voteCount ?? 0,
    ]
  );
}

const vote = (itemId: number, playerId: number, verdict = 'pending') =>
  db.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","questionKey","imageId","stage","answer","weight","verdict","createdAt")
     VALUES ($1,$2,$3,1,'Knight','yes',1,$4,TIMESTAMP '2026-12-27 12:00:00')`,
    [itemId, playerId, AXIS, verdict]
  );

const row = async (id: number) =>
  (
    await db.query<{
      status: string;
      reason: string | null;
      prompt: string;
      voteCount: number;
      meta: Record<string, unknown> | null;
      imageId: number;
      questionKey: string;
      audience: string;
      yesEffect: string | null;
      resolvedAt: string | null;
    }>(`SELECT *, "resolvedAt"::text AS "resolvedAt" FROM "KnightsQueueItem" WHERE "id" = $1`, [id])
  ).rows[0];
const verdicts = async (itemId: number) =>
  (
    await db.query<{ verdict: string }>(
      `SELECT "verdict" FROM "KnightsVote" WHERE "itemId" = $1 ORDER BY "playerId"`,
      [itemId]
    )
  ).rows.map((r) => r.verdict);

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`CREATE TABLE "Image" (
    "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "name" TEXT, "type" TEXT NOT NULL DEFAULT 'image'
  );`);
  await db.exec(
    readFileSync(path.join(MIGRATIONS, '20261210120000_knights_v2_tables', 'migration.sql'), 'utf8')
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(
    `DELETE FROM "KnightsVote"; DELETE FROM "KnightsQueueItem"; DELETE FROM "KnightsQuestion"; DELETE FROM "Image";
     SELECT setval(pg_get_serial_sequence('"KnightsQueueItem"', 'id'), 1000);
     INSERT INTO "Image" ("id","url","name") VALUES (1,'k1','a.png'), (2,'k2',NULL), (3,'k3',NULL);
     INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES
       ('${AXIS}','bool','Violence?','[]'), ('${OTHER_AXIS}','bool','Profanity?','[]');`
  );
});

describe('limits', () => {
  it('uses the same question length as the import', () => {
    expect(YESNO_PROMPT_MAX).toBe(YESNO_QUESTION_MAX);
  });
});

describe('getYesNoQuestionItems', () => {
  beforeEach(async () => {
    await seedItem(1, { imageId: 1, prompt: 'Is a knife held?' });
    await seedItem(2, { imageId: 2, axis: OTHER_AXIS, prompt: 'Is there 100% profanity?' });
    await seedItem(3, {
      imageId: 1,
      status: 'Closed',
      reason: 'retired',
      prompt: 'Is blood shown?',
    });
    await seedItem(4, { imageId: 3, status: 'Consensus', prompt: 'Is a gun drawn?' });
    await seedItem(5, { imageId: 3, audience: 'moderators', prompt: 'Policy question?' });
    await seedItem(6, { imageId: 3, audience: null, prompt: 'Rating item' });
  });

  it('lists only player questions, newest first, with the image and moderation record', async () => {
    await retireYesNoQuestion({ id: 1, by: MOD, note: 'unreadable', now: NOW });
    const { items, total } = await getYesNoQuestionItems();
    expect(items.map((i) => i.id)).toEqual([4, 3, 2, 1]);
    expect(total).toBe(4);
    expect(items[3]).toMatchObject({
      imageKey: 'k1',
      imageName: 'a.png',
      status: 'Closed',
      reason: 'moderator-retired',
      moderation: { action: 'retired', by: MOD, note: 'unreadable' },
    });
  });

  it('filters by axis and by status, where closed means no longer open', async () => {
    expect(
      (await getYesNoQuestionItems({ page: 1, axis: OTHER_AXIS })).items.map((i) => i.id)
    ).toEqual([2]);
    expect(
      (await getYesNoQuestionItems({ page: 1, status: 'open' })).items.map((i) => i.id)
    ).toEqual([2, 1]);
    expect(
      (await getYesNoQuestionItems({ page: 1, status: 'closed' })).items.map((i) => i.id)
    ).toEqual([4, 3]);
    expect((await getYesNoQuestionItems({ page: 1, status: 'all' })).total).toBe(4);
  });

  it('searches the prompt case-insensitively, taking % and _ literally, and the image', async () => {
    expect(
      (await getYesNoQuestionItems({ page: 1, text: 'KNIFE' })).items.map((i) => i.id)
    ).toEqual([1]);
    expect((await getYesNoQuestionItems({ page: 1, text: '100%' })).items.map((i) => i.id)).toEqual(
      [2]
    );
    expect((await getYesNoQuestionItems({ page: 1, text: '%' })).total).toBe(1);
    expect((await getYesNoQuestionItems({ page: 1, imageId: 1 })).items.map((i) => i.id)).toEqual([
      3, 1,
    ]);
    expect(
      (await getYesNoQuestionItems({ page: 1, imageId: 1, text: 'blood' })).items.map((i) => i.id)
    ).toEqual([3]);
  });

  it('pages with a total and clamps a stale page to the last', async () => {
    const first = await getYesNoQuestionItems({ page: 1 }, 3);
    expect(first.items.map((i) => i.id)).toEqual([4, 3, 2]);
    expect(first.total).toBe(4);
    const last = await getYesNoQuestionItems({ page: 9 }, 3);
    expect(last).toMatchObject({ page: 2, total: 4 });
    expect(last.items.map((i) => i.id)).toEqual([1]);
  });

  it('lists the yes/no axes', async () => {
    expect((await getYesNoAxes()).map((a) => a.key)).toEqual([OTHER_AXIS, AXIS]);
  });
});

describe('retireYesNoQuestion', () => {
  it('closes an open question as moderator-retired, settles its pending votes inconclusive and records who and why', async () => {
    await seedItem(1, { voteCount: 3 });
    await vote(1, 10);
    await vote(1, 11);
    await vote(1, 12, 'correct');

    expect(
      await retireYesNoQuestion({ id: 1, by: MOD, note: '  illegible watermark  ', now: NOW })
    ).toEqual({ ok: true });

    expect(await row(1)).toMatchObject({
      status: 'Closed',
      reason: 'moderator-retired',
      voteCount: 3,
      meta: {
        caseId: 'c',
        moderation: {
          action: 'retired',
          by: MOD,
          note: 'illegible watermark',
          at: NOW.toISOString(),
        },
      },
    });
    expect((await row(1)).resolvedAt).toBe('2026-12-27 12:00:00');
    expect(await verdicts(1)).toEqual(['inconclusive', 'inconclusive', 'correct']);
  });

  it('refuses without a note, for an item that is not open, and for one that is not a player question', async () => {
    await seedItem(1);
    await seedItem(2, { status: 'Consensus' });
    await seedItem(3, { audience: 'moderators' });
    expect(await retireYesNoQuestion({ id: 1, by: MOD, note: '   ' })).toMatchObject({ ok: false });
    expect(await retireYesNoQuestion({ id: 2, by: MOD, note: 'x' })).toEqual({
      ok: false,
      error: 'Only an open question can be retired.',
    });
    expect(await retireYesNoQuestion({ id: 3, by: MOD, note: 'x' })).toMatchObject({ ok: false });
    expect(await retireYesNoQuestion({ id: 99, by: MOD, note: 'x' })).toMatchObject({ ok: false });
    expect((await row(1)).status).toBe('Open');
    expect((await row(2)).status).toBe('Consensus');
  });

  it('refuses a second retirement and keeps the first record', async () => {
    await seedItem(1);
    await retireYesNoQuestion({ id: 1, by: MOD, note: 'first', now: NOW });
    expect(await retireYesNoQuestion({ id: 1, by: 9, note: 'second' })).toMatchObject({
      ok: false,
    });
    expect((await row(1)).meta).toMatchObject({ moderation: { by: MOD, note: 'first' } });
  });
});

describe('unretireYesNoQuestion', () => {
  it('reopens a retired question nobody answered', async () => {
    await seedItem(1);
    await retireYesNoQuestion({ id: 1, by: MOD, note: 'oops', now: NOW });

    expect(await unretireYesNoQuestion({ id: 1, by: 9, now: NOW })).toEqual({ ok: true });

    expect(await row(1)).toMatchObject({
      status: 'Open',
      reason: null,
      resolvedAt: null,
      meta: { moderation: { action: 'restored', by: 9 } },
    });
  });

  it('keeps a retired question with answers retired, and refuses anything not retired by a moderator', async () => {
    await seedItem(1, { voteCount: 1 });
    await seedItem(2);
    await seedItem(3, { status: 'Closed', reason: 'retired' });
    await retireYesNoQuestion({ id: 1, by: MOD, note: 'x' });
    expect(await unretireYesNoQuestion({ id: 1, by: MOD })).toMatchObject({ ok: false });
    expect((await row(1)).status).toBe('Closed');
    expect(await unretireYesNoQuestion({ id: 2, by: MOD })).toMatchObject({ ok: false });
    expect(await unretireYesNoQuestion({ id: 3, by: MOD })).toMatchObject({ ok: false });
    expect((await row(3)).status).toBe('Closed');
  });
});

describe('rewordYesNoQuestion', () => {
  it('rewrites the prompt in place while nobody has answered, trimmed and recorded', async () => {
    await seedItem(1);

    expect(
      await rewordYesNoQuestion({
        id: 1,
        prompt: '  Is a blade held?  ',
        by: MOD,
        note: 'clearer',
        now: NOW,
      })
    ).toEqual({ ok: true });

    expect(await row(1)).toMatchObject({
      status: 'Open',
      prompt: 'Is a blade held?',
      meta: { caseId: 'c', moderation: { action: 'reworded', by: MOD, note: 'clearer' } },
    });
    expect((await db.query(`SELECT 1 FROM "KnightsQueueItem"`)).rows).toHaveLength(1);
  });

  it('retires an answered question and opens a :r1 item, then :r2, linked by rewordOf', async () => {
    await seedItem(1, { voteCount: 2, externalId: 'q-1', imageId: 2 });
    await vote(1, 10);

    expect(
      await rewordYesNoQuestion({
        id: 1,
        prompt: 'Is a blade held?',
        by: MOD,
        note: 'clearer',
        now: NOW,
      })
    ).toEqual({ ok: true });

    const created = (
      await db.query<{ id: number }>(
        `SELECT "id" FROM "KnightsQueueItem" WHERE "externalId" = 'q-1:r1'`
      )
    ).rows[0];
    expect(await row(1)).toMatchObject({
      status: 'Closed',
      reason: 'moderator-retired',
      meta: { moderation: { action: 'retired', by: MOD, note: 'Reworded as q-1:r1: clearer' } },
    });
    expect(await verdicts(1)).toEqual(['inconclusive']);
    expect(await row(created.id)).toMatchObject({
      status: 'Open',
      prompt: 'Is a blade held?',
      voteCount: 0,
      imageId: 2,
      questionKey: AXIS,
      audience: 'players',
      yesEffect: 'R4',
      meta: { caseId: 'c', rewordOf: 'q-1', moderation: { action: 'reworded', by: MOD } },
    });

    // The new item has no votes yet, so rewording it again rewrites it in place.
    await rewordYesNoQuestion({
      id: created.id,
      prompt: 'Is a dagger held?',
      by: MOD,
      note: 'again',
    });
    expect((await row(created.id)).prompt).toBe('Is a dagger held?');
  });

  it('takes the next free :rN', async () => {
    await seedItem(1, { voteCount: 2, externalId: 'q-1' });
    await seedItem(2, { status: 'Closed', reason: 'moderator-retired', externalId: 'q-1:r1' });
    await seedItem(3, { status: 'Closed', reason: 'moderator-retired', externalId: 'q-1:r4' });
    await seedItem(4, { externalId: 'q-1x:r9' });

    await rewordYesNoQuestion({ id: 1, prompt: 'New words?', by: MOD, note: 'n' });

    const ids = await db.query<{ externalId: string }>(
      `SELECT "externalId" FROM "KnightsQueueItem" WHERE "externalId" LIKE 'q-1:r%' ORDER BY "id"`
    );
    expect(ids.rows.map((r) => r.externalId)).toEqual(['q-1:r1', 'q-1:r4', 'q-1:r5']);
  });

  it('refuses an empty, unchanged or over-long prompt, a missing note, and an item that is not open', async () => {
    await seedItem(1, { prompt: 'Same?' });
    await seedItem(2, { status: 'Closed', reason: 'moderator-retired' });
    expect(await rewordYesNoQuestion({ id: 1, prompt: ' ', by: MOD, note: 'n' })).toMatchObject({
      ok: false,
    });
    expect(await rewordYesNoQuestion({ id: 1, prompt: 'Same?', by: MOD, note: 'n' })).toMatchObject(
      { ok: false }
    );
    expect(
      await rewordYesNoQuestion({
        id: 1,
        prompt: 'x'.repeat(YESNO_QUESTION_MAX + 1),
        by: MOD,
        note: 'n',
      })
    ).toMatchObject({ ok: false });
    expect(
      await rewordYesNoQuestion({ id: 1, prompt: 'Other?', by: MOD, note: ' ' })
    ).toMatchObject({ ok: false });
    expect(
      await rewordYesNoQuestion({ id: 2, prompt: 'Other?', by: MOD, note: 'n' })
    ).toMatchObject({ ok: false });
    expect((await row(1)).prompt).toBe('Same?');
    expect((await db.query(`SELECT 1 FROM "KnightsQueueItem"`)).rows).toHaveLength(2);
  });
});
