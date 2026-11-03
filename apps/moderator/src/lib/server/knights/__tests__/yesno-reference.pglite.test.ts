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
    throw new Error('the yes/no reference manager must read from the primary, not the replica');
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const {
  addYesNoReference,
  deleteYesNoReference,
  getYesNoQuestions,
  getYesNoReferenceCount,
  getYesNoReferences,
  setYesNoReferenceActive,
} = await import('../yesno-reference.service');

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations'
);

let db: PGlite;

async function seedImage(id: number, o: { published?: boolean } = {}) {
  await db.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,$2)`, [
    id,
    o.published === false ? null : '2020-01-01',
  ]);
  await db.query(
    `INSERT INTO "Image" ("id","url","type","nsfwLevel","postId") VALUES ($1,$2,'image',4,$1)`,
    [id, `key-${id}`]
  );
}

async function seedQuestion(key: string, kind = 'bool', active = true) {
  await db.query(
    `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options","active") VALUES ($1,$2,$3,'[]',$4)`,
    [key, kind, `Prompt for ${key}`, active]
  );
}

const rows = async () =>
  (
    await db.query<{
      imageId: number;
      questionKey: string;
      answer: boolean;
      explanation: string | null;
      active: boolean;
      createdBy: number;
    }>(
      `SELECT "imageId","questionKey","answer","explanation","active","createdBy" FROM "KnightsYesNoReference" ORDER BY "id"`
    )
  ).rows;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "publishedAt" TIMESTAMP);
    CREATE TABLE "Image" (
      "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "name" TEXT, "type" TEXT NOT NULL DEFAULT 'image',
      "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "ingestion" TEXT NOT NULL DEFAULT 'Scanned',
      "blockedFor" TEXT, "needsReview" TEXT, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false, "postId" INTEGER
    );`);
  for (const name of [
    '20261210120000_knights_v2_queue',
    '20261224120000_knights_v2_yesno_reference',
  ]) {
    await db.exec(readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
  }
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(
    `TRUNCATE "KnightsYesNoReference","KnightsQueueItem","KnightsQuestion","Image","Post" RESTART IDENTITY CASCADE`
  );
});

const pair = {
  imageId: 1,
  questionKey: 'q.safe',
  answer: true,
  explanation: '  Looks fine.  ',
  createdBy: 9,
};

describe('addYesNoReference', () => {
  it('stores an active pair with the trimmed explanation and the acting moderator', async () => {
    await seedImage(1);
    await seedQuestion('q.safe');

    expect(await addYesNoReference(pair)).toEqual({ ok: true });
    expect(await rows()).toEqual([
      {
        imageId: 1,
        questionKey: 'q.safe',
        answer: true,
        explanation: 'Looks fine.',
        active: true,
        createdBy: 9,
      },
    ]);
  });

  it('stores a blank explanation as null', async () => {
    await seedImage(1);
    await seedQuestion('q.safe');
    await addYesNoReference({ ...pair, explanation: '   ' });
    expect((await rows())[0].explanation).toBeNull();
  });

  it('refuses an image that does not exist', async () => {
    await seedQuestion('q.safe');
    expect(await addYesNoReference(pair)).toEqual({ ok: false, error: 'Image 1 was not found.' });
    expect(await rows()).toEqual([]);
  });

  it('refuses an image Acolytes could not be shown', async () => {
    await seedImage(1, { published: false });
    await seedQuestion('q.safe');
    expect(await addYesNoReference(pair)).toMatchObject({ ok: false });
    expect(await rows()).toEqual([]);
  });

  it('refuses a question that does not exist or is not yes/no', async () => {
    await seedImage(1);
    await seedQuestion('q.rating', 'choice');
    expect(await addYesNoReference(pair)).toEqual({
      ok: false,
      error: expect.stringContaining('not found'),
    });
    expect(await addYesNoReference({ ...pair, questionKey: 'q.rating' })).toEqual({
      ok: false,
      error: expect.stringContaining('not a yes/no question'),
    });
    expect(await rows()).toEqual([]);
  });

  it('refuses a second pair for the same image and question, but allows another question', async () => {
    await seedImage(1);
    await seedQuestion('q.safe');
    await seedQuestion('q.other');
    await addYesNoReference(pair);

    expect(await addYesNoReference({ ...pair, answer: false })).toEqual({
      ok: false,
      error: expect.stringContaining('already has a reference'),
    });
    expect(await addYesNoReference({ ...pair, questionKey: 'q.other' })).toEqual({ ok: true });
    expect((await rows()).length).toBe(2);
    expect((await rows())[0].answer).toBe(true);
  });
});

describe('setYesNoReferenceActive', () => {
  it('toggles the flag and reports a missing pair', async () => {
    await seedImage(1);
    await seedQuestion('q.safe');
    await addYesNoReference(pair);

    expect(await setYesNoReferenceActive(1, false)).toEqual({ ok: true });
    expect((await rows())[0].active).toBe(false);
    expect(await setYesNoReferenceActive(1, true)).toEqual({ ok: true });
    expect((await rows())[0].active).toBe(true);
    expect(await setYesNoReferenceActive(99, false)).toMatchObject({ ok: false });
  });
});

describe('deleteYesNoReference', () => {
  it('removes the pair and reports one already gone', async () => {
    await seedImage(1);
    await seedQuestion('q.safe');
    await addYesNoReference(pair);

    expect(await deleteYesNoReference(1)).toEqual({ ok: true });
    expect(await rows()).toEqual([]);
    expect(await deleteYesNoReference(1)).toMatchObject({ ok: false });
  });

  it('is removed with its image', async () => {
    await seedImage(1);
    await seedQuestion('q.safe');
    await addYesNoReference(pair);
    await db.query(`DELETE FROM "Image" WHERE "id"=1`);
    expect(await rows()).toEqual([]);
  });
});

describe('listing', () => {
  it('lists pairs with their question prompt, active first, and counts the active ones', async () => {
    await seedImage(1);
    await seedImage(2);
    await seedQuestion('q.safe');
    await seedQuestion('q.off', 'bool', false);
    await seedQuestion('q.rating', 'choice');
    await addYesNoReference(pair);
    await addYesNoReference({ ...pair, imageId: 2, answer: false });
    await setYesNoReferenceActive(1, false);

    const items = await getYesNoReferences();
    expect(items.map((i) => [i.imageId, i.active, i.questionPrompt, i.imageKey])).toEqual([
      [2, true, 'Prompt for q.safe', 'key-2'],
      [1, false, 'Prompt for q.safe', 'key-1'],
    ]);
    expect(await getYesNoReferenceCount()).toBe(1);
    expect((await getYesNoQuestions()).map((q) => q.key)).toEqual(['q.off', 'q.safe']);
  });
});
