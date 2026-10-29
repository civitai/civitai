import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../../db', () => ({
  get dbRead() {
    throw new Error('the core-set manager must read from the primary, not the replica');
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const {
  addCoreImage,
  getCoreItems,
  getFreshItems,
  getSpotCheckItems,
  promoteToCore,
  retireReference,
  spotCheckItem,
  updateCoreItem,
} = await import('../coreset.service');

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations'
);

let db: PGlite;

async function seedImage(
  id: number,
  o: { level?: number; published?: boolean; ingestion?: string; needsReview?: string } = {}
) {
  await db.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,$2)`, [
    id,
    o.published === false ? null : '2020-01-01',
  ]);
  await db.query(
    `INSERT INTO "Image" ("id","url","type","nsfwLevel","ingestion","needsReview","postId") VALUES ($1,$2,'image',$3,$4,$5,$1)`,
    [id, `key-${id}`, o.level ?? 4, o.ingestion ?? 'Scanned', o.needsReview ?? null]
  );
}

async function seedRef(
  imageId: number,
  o: Partial<{
    pool: string;
    source: string;
    status: string;
    answer: string;
    explanation: string | null;
    answers: number;
    failures: number;
    daysOld: number;
  }> = {}
) {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","explanation","status","answers","failures","harvestedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - ($9::int * interval '1 day')) RETURNING "id"`,
    [
      imageId,
      o.pool ?? 'trials',
      o.answer ?? '4',
      o.source ?? 'harvested',
      o.explanation ?? null,
      o.status ?? 'active',
      o.answers ?? 0,
      o.failures ?? 0,
      o.daysOld ?? 0,
    ]
  );
  return rows[0].id;
}

const row = async (id: number) =>
  (
    await db.query<{
      source: string;
      status: string;
      answer: string;
      explanation: string | null;
      pool: string;
      answers: number;
      failures: number;
    }>(
      `SELECT "source","status","answer","explanation","pool","answers","failures" FROM "KnightsReferenceImage" WHERE "id"=$1`,
      [id]
    )
  ).rows[0];

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "publishedAt" TIMESTAMP);
    CREATE TABLE "Image" (
      "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "name" TEXT, "type" TEXT NOT NULL DEFAULT 'image',
      "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "ingestion" TEXT NOT NULL DEFAULT 'Scanned',
      "blockedFor" TEXT, "needsReview" TEXT, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false, "postId" INTEGER
    );`);
  await db.exec(
    readFileSync(path.join(MIGRATIONS, '20261212120000_knights_v2_trials', 'migration.sql'), 'utf8')
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(
    `TRUNCATE "KnightsTrialAnswer","KnightsTrialRun","KnightsReferenceImage","Image","Post" RESTART IDENTITY CASCADE`
  );
});

describe('addCoreImage', () => {
  it('adds a published image as an active core item with its answer and why', async () => {
    await seedImage(1);

    const result = await addCoreImage({ imageId: 1, level: 8, explanation: '  Explicit act.  ' });

    expect(result).toEqual({ ok: true });
    expect(await db.query(`SELECT * FROM "KnightsReferenceImage"`)).toMatchObject({
      rows: [
        {
          imageId: 1,
          pool: 'trials',
          source: 'core',
          status: 'active',
          answer: '8',
          explanation: 'Explicit act.',
        },
      ],
    });
  });

  it.each([
    ['a missing image', async () => undefined, 99, 'was not found'],
    ['an unpublished image', async () => seedImage(1, { published: false }), 1, 'published'],
    ['a blocked image', async () => seedImage(1, { ingestion: 'Blocked' }), 1, 'blocked'],
  ])('refuses %s', async (_label, setup, imageId, message) => {
    await setup();
    const result = await addCoreImage({ imageId, level: 4, explanation: 'why' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(message) });
    expect((await db.query(`SELECT 1 FROM "KnightsReferenceImage"`)).rows).toHaveLength(0);
  });

  it('refuses an image that is a hidden check, so it never sits in both pools', async () => {
    await seedImage(1);
    const id = await seedRef(1, { pool: 'hiddenCheck', source: 'harvested' });

    const result = await addCoreImage({ imageId: 1, level: 4, explanation: 'why' });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('hidden check') });
    expect(await row(id)).toMatchObject({ pool: 'hiddenCheck', source: 'harvested' });
  });

  it('refuses an image that is already an active core item', async () => {
    await seedImage(1);
    await seedRef(1, { source: 'core', explanation: 'why' });
    expect(await addCoreImage({ imageId: 1, level: 4, explanation: 'x' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('already'),
    });
  });

  it('turns a fresh or retired item of that image into core', async () => {
    await seedImage(1);
    await seedImage(2);
    const fresh = await seedRef(1, { answer: '4', answers: 5, failures: 1 });
    const retired = await seedRef(2, { source: 'core', status: 'retired', explanation: 'old' });

    expect(await addCoreImage({ imageId: 1, level: 2, explanation: 'new why' })).toEqual({
      ok: true,
    });
    expect(await addCoreImage({ imageId: 2, level: 2, explanation: 'again' })).toEqual({
      ok: true,
    });

    expect(await row(fresh)).toMatchObject({
      source: 'core',
      status: 'active',
      answer: '2',
      explanation: 'new why',
    });
    expect(await row(retired)).toMatchObject({ status: 'active', explanation: 'again' });
  });

  it('refuses an image Acolytes would not be shown, such as one under review', async () => {
    await seedImage(1, { needsReview: 'minor' });
    expect(await addCoreImage({ imageId: 1, level: 4, explanation: 'why' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('review hold'),
    });
  });

  it('starts the answer record over when converting to a different answer, and keeps it for the same one', async () => {
    await seedImage(1);
    await seedImage(2);
    const changed = await seedRef(1, { answer: '4', answers: 9, failures: 5 });
    const same = await seedRef(2, { answer: '4', answers: 9, failures: 5 });

    await addCoreImage({ imageId: 1, level: 8, explanation: 'why' });
    await addCoreImage({ imageId: 2, level: 4, explanation: 'why' });

    expect(await row(changed)).toMatchObject({ answers: 0, failures: 0 });
    expect(await row(same)).toMatchObject({ answers: 9, failures: 5 });
  });

  it('requires a why and a rating level', async () => {
    await seedImage(1);
    expect(await addCoreImage({ imageId: 1, level: 4, explanation: '   ' })).toMatchObject({
      ok: false,
    });
    expect(await addCoreImage({ imageId: 1, level: 3, explanation: 'why' })).toMatchObject({
      ok: false,
    });
  });
});

describe('updateCoreItem', () => {
  it('edits the why and answer of an active core item only', async () => {
    await seedImage(1);
    await seedImage(2);
    const core = await seedRef(1, { source: 'core', explanation: 'old' });
    const fresh = await seedRef(2);

    expect(await updateCoreItem({ id: core, level: 16, explanation: 'better' })).toEqual({
      ok: true,
    });
    expect(await updateCoreItem({ id: fresh, level: 16, explanation: 'x' })).toMatchObject({
      ok: false,
    });

    expect(await row(core)).toMatchObject({ answer: '16', explanation: 'better' });
    expect(await row(fresh)).toMatchObject({ answer: '4', explanation: null });
  });
});

describe('updateCoreItem answer record', () => {
  it('resets the counts when the answer changes, not when only the why does', async () => {
    await seedImage(1);
    const id = await seedRef(1, { source: 'core', explanation: 'old', answers: 12, failures: 7 });

    await updateCoreItem({ id, level: 4, explanation: 'reworded' });
    expect(await row(id)).toMatchObject({ answers: 12, failures: 7 });

    await updateCoreItem({ id, level: 8, explanation: 'reworded' });
    expect(await row(id)).toMatchObject({ answers: 0, failures: 0 });
  });
});

describe('retireReference', () => {
  it('retires a core or fresh item and takes it out of the Trials pool', async () => {
    await seedImage(1);
    const id = await seedRef(1, { source: 'core', explanation: 'why' });

    expect(await retireReference(id)).toEqual({ ok: true });

    expect((await row(id)).status).toBe('retired');
    expect((await getCoreItems()).map((i) => i.id)).toEqual([id]);
    expect((await getCoreItems())[0].status).toBe('retired');
  });

  it('reports an item that is already gone', async () => {
    expect(await retireReference(999)).toMatchObject({ ok: false });
  });
});

describe('promoteToCore', () => {
  it('promotes an active fresh Trials item, keeping its answer, with an optional why', async () => {
    await seedImage(1, { level: 8 });
    const id = await seedRef(1, { answer: '8' });

    expect(await promoteToCore({ id, explanation: '' })).toEqual({ ok: true });

    expect(await row(id)).toMatchObject({
      source: 'core',
      status: 'active',
      answer: '8',
      explanation: null,
      pool: 'trials',
    });
  });

  it.each([
    ['a hidden check', { pool: 'hiddenCheck' }],
    ['a retired item', { status: 'retired' }],
    ['a pending item', { status: 'pending' }],
    ['a core item', { source: 'core' }],
  ])('refuses %s', async (_label, o) => {
    await seedImage(1);
    const id = await seedRef(1, o);
    const before = await row(id);

    expect(await promoteToCore({ id, explanation: 'x' })).toMatchObject({ ok: false });
    expect(await row(id)).toEqual(before);
  });
});

describe('lists', () => {
  it('lists core items with the missing why visible, and fresh Trials items apart from them', async () => {
    await seedImage(1);
    await seedImage(2);
    await seedImage(3);
    await seedImage(4);
    await seedImage(5);
    await seedRef(1, { source: 'core', explanation: 'why' });
    await seedRef(2, { source: 'core', explanation: null });
    await seedRef(3);
    await seedRef(4, { pool: 'hiddenCheck' });
    const pendingId = await seedRef(5, { status: 'pending' });

    expect((await getCoreItems()).map((i) => i.imageId).sort()).toEqual([1, 2]);
    expect((await getFreshItems()).map((i) => i.imageId)).toEqual([3]);
    expect((await getSpotCheckItems()).map((i) => i.id)).toEqual([pendingId]);
  });

  it('flags an item players fail far more than expected, once it has enough answers', async () => {
    for (const id of [1, 2, 3, 4]) await seedImage(id);
    await seedRef(1, { answers: 30, failures: 25 });
    await seedRef(2, { answers: 30, failures: 3 });
    await seedRef(3, { answers: 4, failures: 4 });
    await seedRef(4, { source: 'core', explanation: 'x', answers: 40, failures: 30 });

    const config = { flagMinAnswers: 20, flagFailureRate: 0.6, listLimit: 200 };
    const flagged = (items: { imageId: number; flagged: boolean }[]) =>
      items.filter((i) => i.flagged).map((i) => i.imageId);

    expect(flagged(await getFreshItems(config))).toEqual([1]);
    expect(flagged(await getCoreItems(config))).toEqual([4]);
    expect((await getFreshItems(config))[0].imageId).toBe(1);
  });

  it('gives the spot-check only the media, never the image id, name or stored rating', async () => {
    await seedImage(1);
    const id = await seedRef(1, { status: 'pending', answer: '16' });
    expect(await getSpotCheckItems()).toEqual([{ id, imageKey: 'key-1' }]);
  });

  it('keeps a flagged item inside the limit even when it is the oldest', async () => {
    for (let n = 1; n <= 6; n++) await seedImage(n);
    await seedRef(1, { answers: 40, failures: 38, daysOld: 50 });
    for (let n = 2; n <= 6; n++) await seedRef(n, { daysOld: n });

    const shown = await getFreshItems({ flagMinAnswers: 20, flagFailureRate: 0.6, listLimit: 3 });

    expect(shown.map((i) => i.imageId)).toEqual([1, 2, 3]);
    expect(shown[0].flagged).toBe(true);
  });

  it('marks core items whose image Acolytes would no longer be shown', async () => {
    await seedImage(1);
    await seedImage(2, { ingestion: 'Blocked' });
    await seedImage(3, { needsReview: 'minor' });
    await seedImage(4, { published: false });
    for (const n of [1, 2, 3, 4]) await seedRef(n, { source: 'core', explanation: 'x' });

    const shown = Object.fromEntries((await getCoreItems()).map((i) => [i.imageId, i.servable]));

    expect(shown).toEqual({ 1: true, 2: false, 3: false, 4: false });
  });
});

describe('spotCheckItem', () => {
  it('lets the item into Trials when the blind rating agrees', async () => {
    await seedImage(1);
    const id = await seedRef(1, { status: 'pending', answer: '8' });
    expect(await spotCheckItem({ id, level: 8 })).toEqual({ ok: true, agreed: true });
    expect((await row(id)).status).toBe('active');
  });

  it('keeps the item out when the blind rating disagrees', async () => {
    await seedImage(1);
    const id = await seedRef(1, { status: 'pending', answer: '8' });
    expect(await spotCheckItem({ id, level: 4 })).toEqual({ ok: true, agreed: false });
    expect((await row(id)).status).toBe('retired');
  });

  it('decides an item once', async () => {
    await seedImage(1);
    const id = await seedRef(1, { status: 'pending', answer: '8' });
    await spotCheckItem({ id, level: 4 });
    expect(await spotCheckItem({ id, level: 8 })).toMatchObject({ ok: false });
    expect((await row(id)).status).toBe('retired');
  });
});
