import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { YESNO_QUESTION_MAX } from '@civitai/db/knights';
import { NOTE_MAX, YESNO_PROMPT_MAX } from '../../../knights/trials-limits';
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
  getOrphanImagePulls,
  keepReportedQuestion,
  returnImagePull,
  removeReportedQuestion,
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
  await db.exec(`CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "publishedAt" TIMESTAMP, "availability" TEXT NOT NULL DEFAULT 'Public');
  CREATE TABLE "Image" (
    "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "name" TEXT, "type" TEXT NOT NULL DEFAULT 'image',
    "nsfwLevel" INTEGER NOT NULL DEFAULT 1, "ingestion" TEXT NOT NULL DEFAULT 'Scanned', "blockedFor" TEXT,
    "needsReview" TEXT, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false, "postId" INTEGER,
    "poi" BOOLEAN NOT NULL DEFAULT false,
    "minor" BOOLEAN NOT NULL DEFAULT false
  );
  ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "tosViolation" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS "userId" INTEGER;
  ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "modelVersionId" INTEGER;
  CREATE TABLE "User" (id INTEGER PRIMARY KEY, "deletedAt" TIMESTAMP, "bannedAt" TIMESTAMP, muted BOOLEAN NOT NULL DEFAULT false);
  CREATE TABLE "Model" (id INTEGER PRIMARY KEY, status TEXT NOT NULL, availability TEXT NOT NULL, "deletedAt" TIMESTAMP);
  CREATE TABLE "ModelVersion" (id INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, status TEXT NOT NULL, availability TEXT NOT NULL);
  CREATE TABLE "CsamReport" (id SERIAL PRIMARY KEY, "userId" INTEGER, images JSONB NOT NULL DEFAULT '[]', details JSONB);
    CREATE TABLE "ImageCdnModeratorDelete" ("imageId" INTEGER PRIMARY KEY, url TEXT NOT NULL, "csamReview" BOOLEAN NOT NULL DEFAULT true);`);
  await db.exec(
    readFileSync(path.join(MIGRATIONS, '20261210120000_knights_v2_tables', 'migration.sql'), 'utf8')
  );
  await db.exec(
    readFileSync(
      path.join(MIGRATIONS, '20271208120000_knights_question_report', 'migration.sql'),
      'utf8'
    )
  );
  await db.exec(`CREATE TABLE "Report" ("id" INTEGER PRIMARY KEY, "status" TEXT NOT NULL);`);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(
    `DELETE FROM "KnightsQuestionReport"; DELETE FROM "KnightsImagePull"; DELETE FROM "Report";
     DELETE FROM "KnightsVote"; DELETE FROM "KnightsQueueItem"; DELETE FROM "KnightsQuestion"; DELETE FROM "Image"; DELETE FROM "Post";
     SELECT setval(pg_get_serial_sequence('"KnightsQueueItem"', 'id'), 1000);
     INSERT INTO "Post" ("id","publishedAt") VALUES (1,'2020-01-01'), (2,'2020-01-01'), (3,'2020-01-01');
     INSERT INTO "Image" ("id","url","name","postId") VALUES (1,'k1','a.png',1), (2,'k2',NULL,2), (3,'k3',NULL,3);
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
      retired: true,
      moderation: { action: 'retired', by: MOD, note: 'unreadable' },
    });
    expect(items.slice(0, 3).map((i) => i.retired)).toEqual([false, false, false]);
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

  it('searches the prompt case-insensitively, taking % and _ literally, and by image', async () => {
    const ids = async (query: Parameters<typeof getYesNoQuestionItems>[0]) =>
      (await getYesNoQuestionItems(query)).items.map((i) => i.id);
    expect(await ids({ page: 1, search: { text: 'KNIFE' } })).toEqual([1]);
    expect(await ids({ page: 1, search: { text: '100%' } })).toEqual([2]);
    expect((await getYesNoQuestionItems({ page: 1, search: { text: '%' } })).total).toBe(1);
    expect(await ids({ page: 1, imageId: 1 })).toEqual([3, 1]);
  });

  it('matches a bare number against the image id or the question text', async () => {
    await seedItem(7, { imageId: 2, prompt: 'Does the sign read 3?' });
    const ids = async (search: { text: string; imageId?: number }) =>
      (await getYesNoQuestionItems({ page: 1, search })).items.map((i) => i.id);
    expect(await ids({ text: '3', imageId: 3 })).toEqual([7, 4]);
    expect(await ids({ text: '3' })).toEqual([7]);
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

describe('tag review items', () => {
  it('are neither listed nor retired here: their answer is written back to the tag they name', async () => {
    await seedItem(7, { imageId: 1, prompt: 'Should this image have the tag x?' });
    await db.query(`UPDATE "KnightsQueueItem" SET "source" = 'mod-tag-review' WHERE "id" = 7`);
    await seedItem(8, { imageId: 2 });
    expect((await getYesNoQuestionItems()).items.map((i) => i.id)).toEqual([8]);
    expect(await retireYesNoQuestion({ id: 7, by: MOD, note: 'no', now: NOW })).toMatchObject({
      ok: false,
    });
    expect(await row(7)).toMatchObject({ status: 'Open', reason: null });
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

describe('an image that can no longer be served', () => {
  const hold = () => db.query(`UPDATE "Image" SET "needsReview" = 'poi' WHERE "id" = 1`);

  it('keeps a retired question retired', async () => {
    await seedItem(1);
    await retireYesNoQuestion({ id: 1, by: MOD, note: 'oops', now: NOW });
    await hold();

    expect(await unretireYesNoQuestion({ id: 1, by: MOD, now: NOW })).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(await row(1)).toMatchObject({ status: 'Closed', reason: 'moderator-retired' });
  });

  it('refuses a reword and opens no copy, while one on a servable image still goes through', async () => {
    await seedItem(1, { externalId: 'held' });
    await seedItem(2, { externalId: 'clean', imageId: 2 });
    await hold();

    expect(
      await rewordYesNoQuestion({ id: 1, prompt: 'New words?', by: MOD, note: 'x', now: NOW })
    ).toEqual({ ok: false, error: expect.any(String) });
    expect(await row(1)).toMatchObject({ status: 'Open' });
    expect(
      await rewordYesNoQuestion({ id: 2, prompt: 'New words?', by: MOD, note: 'x', now: NOW })
    ).toEqual({ ok: true });
    const copies = await db.query<{ externalId: string }>(
      `SELECT "externalId" FROM "KnightsQueueItem" WHERE "externalId" LIKE '%:r%' ORDER BY 1`
    );
    expect(copies.rows.map((r) => r.externalId)).toEqual(['clean:r1']);
  });
});

describe('restoring a reworded question', () => {
  const rewordX = async () => {
    await seedItem(1, { externalId: 'X' });
    await rewordYesNoQuestion({ id: 1, prompt: 'New words?', by: MOD, note: 'clearer', now: NOW });
    return (
      await db.query<{ id: number }>(
        `SELECT "id" FROM "KnightsQueueItem" WHERE "externalId" = 'X:r1'`
      )
    ).rows[0].id;
  };
  const listed = async (id: number) =>
    (await getYesNoQuestionItems({ page: 1 })).items.find((i) => i.id === id);

  it('refuses while the reworded copy is open, and names it', async () => {
    await rewordX();

    const result = await unretireYesNoQuestion({ id: 1, by: MOD, now: NOW });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('X:r1') });
    expect((await row(1)).status).toBe('Closed');
    expect((await listed(1))?.replacedBy).toBe('X:r1');
  });

  it('refuses the same way for an earlier copy of a longer chain', async () => {
    const r1 = await rewordX();
    await rewordYesNoQuestion({ id: r1, prompt: 'Again?', by: MOD, note: 'n', now: NOW });

    expect(await unretireYesNoQuestion({ id: r1, by: MOD, now: NOW })).toMatchObject({
      ok: false,
      error: expect.stringContaining('X:r2'),
    });
  });

  it('restores once the copy is retired, leaving one open version', async () => {
    const r1 = await rewordX();
    await retireYesNoQuestion({ id: r1, by: MOD, note: 'worse', now: NOW });

    expect((await listed(1))?.replacedBy).toBeNull();
    expect(await unretireYesNoQuestion({ id: 1, by: MOD, now: NOW })).toEqual({ ok: true });

    const open = await db.query<{ externalId: string }>(
      `SELECT "externalId" FROM "KnightsQueueItem" WHERE "status" = 'Open'`
    );
    expect(open.rows).toEqual([{ externalId: 'X' }]);
  });
});

describe('rewordYesNoQuestion', () => {
  const rewordTo = (id: number, prompt: string, note = 'clearer') =>
    rewordYesNoQuestion({ id, prompt, by: MOD, note, now: NOW });
  const idOf = async (externalId: string) =>
    (
      await db.query<{ id: number }>(
        `SELECT "id" FROM "KnightsQueueItem" WHERE "externalId" = $1`,
        [externalId]
      )
    ).rows[0]?.id;

  it('retires an unanswered question too and opens a :r1 item in its place', async () => {
    await seedItem(1, { externalId: 'q-1', imageId: 2 });

    expect(await rewordTo(1, '  Is a blade held?  ')).toEqual({ ok: true });

    expect(await row(1)).toMatchObject({
      status: 'Closed',
      reason: 'moderator-retired',
      prompt: 'Question 1?',
      meta: { moderation: { action: 'retired', by: MOD, note: 'Reworded as q-1:r1: clearer' } },
    });
    expect(await row((await idOf('q-1:r1'))!)).toMatchObject({
      status: 'Open',
      prompt: 'Is a blade held?',
      voteCount: 0,
      imageId: 2,
      questionKey: AXIS,
      audience: 'players',
      yesEffect: 'R4',
      meta: { caseId: 'c', rewordOf: 'q-1', moderation: { action: 'reworded', by: MOD } },
    });
  });

  it('settles an answered question inconclusive and links the copy by rewordOf', async () => {
    await seedItem(1, { voteCount: 2, externalId: 'q-1' });
    await vote(1, 10);

    await rewordTo(1, 'Is a blade held?');

    expect(await verdicts(1)).toEqual(['inconclusive']);
    expect((await row(1)).voteCount).toBe(2);
    expect((await row((await idOf('q-1:r1'))!)).meta).toMatchObject({ rewordOf: 'q-1' });
  });

  it('rewording a reworded copy makes :r2 from the same origin', async () => {
    await seedItem(1, { externalId: 'q-1' });
    await rewordTo(1, 'First words?');
    const r1 = (await idOf('q-1:r1'))!;

    expect(await rewordTo(r1, 'Second words?')).toEqual({ ok: true });

    expect(await row(r1)).toMatchObject({ status: 'Closed', reason: 'moderator-retired' });
    expect(await row((await idOf('q-1:r2'))!)).toMatchObject({
      status: 'Open',
      prompt: 'Second words?',
      meta: { rewordOf: 'q-1' },
    });
    expect(await idOf('q-1:r1:r1')).toBeUndefined();
  });

  it('takes the next free :rN', async () => {
    await seedItem(1, { externalId: 'q-1' });
    await seedItem(2, { status: 'Closed', reason: 'moderator-retired', externalId: 'q-1:r1' });
    await seedItem(3, { status: 'Closed', reason: 'moderator-retired', externalId: 'q-1:r4' });
    await seedItem(4, { externalId: 'q-1x:r9' });

    await rewordTo(1, 'New words?');

    const ids = await db.query<{ externalId: string }>(
      `SELECT "externalId" FROM "KnightsQueueItem" WHERE "externalId" LIKE 'q-1:r%' ORDER BY "id"`
    );
    expect(ids.rows.map((r) => r.externalId)).toEqual(['q-1:r1', 'q-1:r4', 'q-1:r5']);
  });

  it('refuses an empty, unchanged or over-long prompt, a missing note, and an item that is not open', async () => {
    await seedItem(1, { prompt: 'Same?' });
    await seedItem(2, { status: 'Closed', reason: 'moderator-retired' });
    expect(await rewordTo(1, ' ', 'n')).toMatchObject({ ok: false });
    expect(await rewordTo(1, 'Same?', 'n')).toMatchObject({ ok: false });
    expect(await rewordTo(1, 'x'.repeat(YESNO_QUESTION_MAX + 1), 'n')).toMatchObject({
      ok: false,
    });
    expect(await rewordTo(1, 'Other?', ' ')).toMatchObject({ ok: false });
    expect(await rewordTo(1, 'Other?', 'x'.repeat(NOTE_MAX + 1))).toMatchObject({ ok: false });
    expect(await rewordTo(2, 'Other?', 'n')).toMatchObject({ ok: false });
    expect((await row(1)).status).toBe('Open');
    expect((await db.query(`SELECT 1 FROM "KnightsQueueItem"`)).rows).toHaveLength(2);
  });
});

describe('reported questions', () => {
  const report = (
    itemId: number,
    playerId: number,
    reason: 'image' | 'question',
    imageId = 1,
    counted = true
  ) =>
    db.query(
      `INSERT INTO "KnightsQuestionReport" ("playerId","itemId","reason","questionKey","imageId","counted") VALUES ($1,$2,$3,$4,$5,$6)`,
      [playerId, itemId, reason, AXIS, imageId, counted]
    );
  const pullImage = (imageId: number, itemId: number, reportId: number | null, filing = 'filed') =>
    db.query(
      `INSERT INTO "KnightsImagePull" ("imageId","itemId","reason","reportId","filing") VALUES ($1,$2,'players-reported',$3,$4)`,
      [imageId, itemId, reportId, filing]
    );
  const reports = async (itemId: number) =>
    (
      await db.query<{ resolvedBy: number | null; resolved: boolean }>(
        `SELECT "resolvedBy", "resolvedAt" IS NOT NULL AS resolved FROM "KnightsQuestionReport" WHERE "itemId" = $1 AND counted ORDER BY "playerId"`,
        [itemId]
      )
    ).rows;
  const openPulls = async () =>
    (
      await db.query<{ imageId: number }>(
        `SELECT "imageId" FROM "KnightsImagePull" WHERE "resolvedAt" IS NULL ORDER BY "imageId"`
      )
    ).rows.map((r) => r.imageId);
  const reportedItems = async () =>
    (await getYesNoQuestionItems({ page: 1, status: 'reported' })).items;

  beforeEach(async () => {
    await seedItem(1, { imageId: 1, status: 'Reported', voteCount: 1 });
    await seedItem(2, { imageId: 2, status: 'Reported' });
    await seedItem(3, { imageId: 3 });
    await seedItem(4, { imageId: 3, status: 'Closed', reason: 'retired' });
    for (const [player, reason] of [
      [10, 'image'],
      [11, 'image'],
      [12, 'question'],
    ] as const)
      await report(1, player, reason);
    await report(1, 19, 'image', 1, false);
    await report(2, 13, 'question', 2);
    await pullImage(1, 1, 55);
    await db.query(`INSERT INTO "Report" ("id","status") VALUES (55,'Pending')`);
  });

  it('are listed on their own, with the counted reasons, the reporters and the image pull they caused', async () => {
    const { items, total } = await getYesNoQuestionItems({ page: 1, status: 'reported' });
    expect(total).toBe(2);
    expect(items.map((i) => i.id)).toEqual([2, 1]);
    expect(items[1].reported).toEqual({
      image: 2,
      question: 1,
      reporters: [10, 11, 12],
      pull: { causedHere: true, reportId: 55, reportStatus: 'Pending', filing: 'filed' },
    });
    expect(items[0].reported).toEqual({ image: 0, question: 1, reporters: [13], pull: null });
  });

  it('are neither open nor closed', async () => {
    const ids = async (status: 'open' | 'closed') =>
      (await getYesNoQuestionItems({ page: 1, status })).items.map((i) => i.id);
    expect(await ids('open')).toEqual([3]);
    expect(await ids('closed')).toEqual([4]);
    expect((await getYesNoQuestionItems({ page: 1, status: 'open' })).items[0].reported).toBeNull();
  });

  it('show whether the image report is still to file or not needed', async () => {
    await db.query(`UPDATE "KnightsImagePull" SET "reportId" = NULL, "filing" = 'pending'`);
    expect((await reportedItems())[1].reported?.pull).toMatchObject({
      reportId: null,
      filing: 'pending',
    });
    await db.query(`UPDATE "KnightsImagePull" SET "filing" = 'not-needed'`);
    expect((await reportedItems())[1].reported?.pull).toMatchObject({ filing: 'not-needed' });
  });

  it('keep opens the question again, resolves its reports and the image pull it caused', async () => {
    expect(await keepReportedQuestion({ id: 1, by: MOD, now: NOW })).toEqual({ ok: true });

    expect(await row(1)).toMatchObject({
      status: 'Open',
      reason: null,
      resolvedAt: null,
      meta: { moderation: { action: 'kept', by: MOD, note: '', at: NOW.toISOString() } },
    });
    expect(await reports(1)).toEqual([
      { resolvedBy: MOD, resolved: true },
      { resolvedBy: MOD, resolved: true },
      { resolvedBy: MOD, resolved: true },
    ]);
    expect(await openPulls()).toEqual([]);
    expect(await reports(2)).toEqual([{ resolvedBy: null, resolved: false }]);
  });

  it('keeping another question on a pulled image leaves the pull it did not cause', async () => {
    await seedItem(5, { imageId: 1, status: 'Reported' });
    await report(5, 30, 'question');
    expect((await reportedItems()).find((i) => i.id === 5)?.reported?.pull).toMatchObject({
      causedHere: false,
    });

    expect(await keepReportedQuestion({ id: 5, by: MOD, now: NOW })).toEqual({ ok: true });

    expect(await row(5)).toMatchObject({ status: 'Open' });
    expect(await openPulls()).toEqual([1]);
  });

  it('keep refuses a question whose image can no longer be shown, as a restore does', async () => {
    await db.query(`UPDATE "Image" SET "ingestion" = 'Blocked' WHERE id = 1`);
    expect(await keepReportedQuestion({ id: 1, by: MOD, now: NOW })).toMatchObject({ ok: false });
    expect(await row(1)).toMatchObject({ status: 'Reported' });
  });

  it('remove closes the question for good with no label: pending answers inconclusive, reports resolved, the image stays pulled', async () => {
    await vote(1, 20);
    expect(await removeReportedQuestion({ id: 1, by: MOD, now: NOW })).toEqual({ ok: true });

    expect(await row(1)).toMatchObject({
      status: 'Closed',
      reason: 'report-removed',
      meta: { moderation: { action: 'removed', by: MOD } },
    });
    expect(
      (await db.query(`SELECT "resolvedValue" FROM "KnightsQueueItem" WHERE id = 1`)).rows
    ).toEqual([{ resolvedValue: null }]);
    expect(await verdicts(1)).toEqual(['inconclusive']);
    expect((await reports(1)).every((r) => r.resolved && r.resolvedBy === MOD)).toBe(true);
    expect(await openPulls()).toEqual([1]);
    expect(await unretireYesNoQuestion({ id: 1, by: MOD, now: NOW })).toMatchObject({ ok: false });
  });

  it('lists a pull whose question was removed, with that question and its reasons, and returns the image', async () => {
    expect(await getOrphanImagePulls()).toEqual([]);
    await removeReportedQuestion({ id: 1, by: MOD, now: NOW });

    const [pull] = await getOrphanImagePulls();
    expect(pull).toMatchObject({
      imageId: 1,
      imageKey: 'k1',
      itemId: 1,
      prompt: 'Question 1?',
      image: 2,
      question: 1,
      reportId: 55,
      reportStatus: 'Pending',
      filing: 'filed',
    });

    expect(await returnImagePull({ id: pull.id, by: MOD, now: NOW })).toEqual({ ok: true });
    expect(await openPulls()).toEqual([]);
    expect(await getOrphanImagePulls()).toEqual([]);
    expect(await returnImagePull({ id: pull.id, by: MOD, now: NOW })).toMatchObject({ ok: false });
  });

  it('return refuses a pull whose question still waits for a keep or remove', async () => {
    const id = (await db.query<{ id: number }>(`SELECT id FROM "KnightsImagePull"`)).rows[0].id;
    expect(await returnImagePull({ id, by: MOD, now: NOW })).toMatchObject({ ok: false });
    expect(await openPulls()).toEqual([1]);
  });

  it('keep and remove refuse a question that is not reported', async () => {
    expect(await keepReportedQuestion({ id: 3, by: MOD, now: NOW })).toMatchObject({ ok: false });
    expect(await removeReportedQuestion({ id: 3, by: MOD, now: NOW })).toMatchObject({
      ok: false,
    });
    expect(await removeReportedQuestion({ id: 999, by: MOD, now: NOW })).toMatchObject({
      ok: false,
    });
    expect(await row(3)).toMatchObject({ status: 'Open' });
  });
});
