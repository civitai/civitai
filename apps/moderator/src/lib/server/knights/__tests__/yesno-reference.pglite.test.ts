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
  updateYesNoReference,
} = await import('../yesno-reference.service');

import { YESNO_PROMPT_MAX } from '../../../knights/trials-limits';

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
      prompt: string | null;
      active: boolean;
      createdBy: number;
    }>(
      `SELECT "imageId","questionKey","answer","explanation","prompt","active","createdBy" FROM "KnightsYesNoReference" ORDER BY "id"`
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
    `TRUNCATE "KnightsApprenticeAnswer","KnightsYesNoReference","KnightsQueueItem","KnightsQuestion","Image","Post" RESTART IDENTITY CASCADE`
  );
});

const pair = {
  imageId: 1,
  questionKey: 'q.safe',
  prompt: '  Is anything unsafe shown?  ',
  answer: true,
  explanation: '  Looks fine.  ',
  createdBy: 9,
};

describe('addYesNoReference', () => {
  it('stores an active pair with the trimmed prompt and explanation and the acting moderator', async () => {
    await seedImage(1);
    await seedQuestion('q.safe');

    expect(await addYesNoReference(pair)).toEqual({ ok: true });
    expect(await rows()).toEqual([
      {
        imageId: 1,
        questionKey: 'q.safe',
        answer: true,
        explanation: 'Looks fine.',
        prompt: 'Is anything unsafe shown?',
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

  it('refuses a pair without a question, whatever else it carries', async () => {
    await seedImage(1);
    await seedQuestion('q.safe');
    expect(await addYesNoReference({ ...pair, prompt: '   ' })).toEqual({
      ok: false,
      error: expect.stringContaining('question'),
    });
    expect(await rows()).toEqual([]);
  });

  it('refuses a question longer than the limit, trimmed', async () => {
    await seedImage(1);
    await seedQuestion('q.safe');
    expect(await addYesNoReference({ ...pair, prompt: 'x'.repeat(YESNO_PROMPT_MAX + 1) })).toEqual({
      ok: false,
      error: expect.stringContaining(String(YESNO_PROMPT_MAX)),
    });
    expect(await rows()).toEqual([]);
    expect(
      await addYesNoReference({ ...pair, prompt: ` ${'x'.repeat(YESNO_PROMPT_MAX)} ` })
    ).toEqual({ ok: true });
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

describe('a pair that has answers', () => {
  const answer = async (pairId: number, playerId = 5) =>
    db.query(
      `INSERT INTO "KnightsApprenticeAnswer" ("playerId","yesNoReferenceId","imageId","questionKey","answer","correctAnswer","correct")
       VALUES ($1,$2,1,'q.safe','yes','yes',true)`,
      [playerId, pairId]
    );
  const answerCount = async () =>
    Number(
      (await db.query<{ n: string }>(`SELECT count(*) AS n FROM "KnightsApprenticeAnswer"`)).rows[0]
        .n
    );

  beforeEach(async () => {
    await seedImage(1);
    await seedQuestion('q.safe');
    await addYesNoReference(pair);
  });

  it('cannot be deleted, only deactivated, and keeps its answers', async () => {
    await answer(1);
    expect(await deleteYesNoReference(1)).toEqual({
      ok: false,
      error: expect.stringContaining('Deactivate'),
    });
    expect(await rows()).toHaveLength(1);
    expect(await answerCount()).toBe(1);
    expect(await setYesNoReferenceActive(1, false)).toEqual({ ok: true });
  });

  it('cannot be edited, since the recap grades against the answer as it stood', async () => {
    await answer(1);
    expect(
      await updateYesNoReference(1, { answer: false, explanation: 'Changed', prompt: 'Changed?' })
    ).toEqual({
      ok: false,
      error: expect.stringContaining('Deactivate'),
    });
    expect(await rows()).toEqual([
      expect.objectContaining({ answer: true, prompt: 'Is anything unsafe shown?' }),
    ]);
  });

  it('keeps the answer, with the image and question it was given for, when its image is deleted', async () => {
    await answer(1);
    await db.query(`DELETE FROM "Image" WHERE "id"=1`);
    const kept = await db.query(
      `SELECT "yesNoReferenceId","imageId","questionKey" FROM "KnightsApprenticeAnswer"`
    );
    expect(kept.rows).toEqual([{ yesNoReferenceId: null, imageId: 1, questionKey: 'q.safe' }]);
  });
});

describe('updateYesNoReference', () => {
  beforeEach(async () => {
    await seedImage(1);
    await seedQuestion('q.safe');
    await addYesNoReference(pair);
  });

  it('changes the answer, the trimmed prompt and explanation, leaving the rest alone', async () => {
    expect(
      await updateYesNoReference(1, {
        answer: false,
        explanation: '  Weapon.  ',
        prompt: '  Is a weapon shown?  ',
      })
    ).toEqual({ ok: true });
    expect(await rows()).toEqual([
      expect.objectContaining({
        imageId: 1,
        active: true,
        answer: false,
        explanation: 'Weapon.',
        prompt: 'Is a weapon shown?',
      }),
    ]);
    await updateYesNoReference(1, {
      answer: false,
      explanation: '  ',
      prompt: 'Is a weapon shown?',
    });
    expect((await rows())[0].explanation).toBeNull();
  });

  it('will not blank the question of an unanswered pair', async () => {
    expect(
      await updateYesNoReference(1, { answer: true, explanation: '', prompt: ' ' })
    ).toMatchObject({
      ok: false,
    });
    expect((await rows())[0].prompt).toBe('Is anything unsafe shown?');
  });

  it('will not save a question longer than the limit', async () => {
    expect(
      await updateYesNoReference(1, {
        answer: true,
        explanation: '',
        prompt: 'x'.repeat(YESNO_PROMPT_MAX + 1),
      })
    ).toMatchObject({ ok: false });
    expect((await rows())[0].prompt).toBe('Is anything unsafe shown?');
  });

  it('gives a pair made before prompts existed its question the first time it is edited', async () => {
    await db.query(`UPDATE "KnightsYesNoReference" SET "prompt" = NULL`);
    expect(
      await updateYesNoReference(1, { answer: true, explanation: '', prompt: 'Now asked?' })
    ).toEqual({
      ok: true,
    });
    expect((await rows())[0].prompt).toBe('Now asked?');
  });

  it('reports a pair that is gone', async () => {
    expect(
      await updateYesNoReference(99, { answer: true, explanation: '', prompt: 'Asked?' })
    ).toMatchObject({ ok: false });
  });
});

describe('listing', () => {
  it('lists pairs with their prompt and question prompt, active first, and counts the active ones', async () => {
    await seedImage(1);
    await seedImage(2);
    await seedQuestion('q.safe');
    await seedQuestion('q.off', 'bool', false);
    await seedQuestion('q.rating', 'choice');
    await addYesNoReference(pair);
    await addYesNoReference({ ...pair, imageId: 2, answer: false, prompt: 'Second?' });
    await setYesNoReferenceActive(1, false);
    await db.query(`UPDATE "KnightsYesNoReference" SET "prompt" = NULL WHERE "id" = 1`);

    const { items, total } = await getYesNoReferences();
    expect(items.map((i) => [i.imageId, i.active, i.prompt, i.questionPrompt, i.imageKey])).toEqual(
      [
        [2, true, 'Second?', 'Prompt for q.safe', 'key-2'],
        [1, false, null, 'Prompt for q.safe', 'key-1'],
      ]
    );
    expect(total).toBe(2);
    expect(await getYesNoReferenceCount()).toBe(1);
    expect((await getYesNoQuestions()).map((q) => q.key)).toEqual(['q.off', 'q.safe']);
  });

  describe('paging and search', () => {
    beforeEach(async () => {
      await seedQuestion('q.safe');
      for (let n = 1; n <= 5; n++) {
        await seedImage(n);
        await addYesNoReference({ ...pair, imageId: n, prompt: `Question ${n}?` });
      }
      await setYesNoReferenceActive(2, false);
    });

    it('returns disjoint consecutive pages in list order, with the total on each', async () => {
      const pages = [];
      for (const page of [1, 2, 3]) pages.push(await getYesNoReferences({ page }, 2));
      expect(pages.map((p) => p.items.map((i) => i.imageId))).toEqual([[5, 4], [3, 1], [2]]);
      expect(pages.map((p) => p.total)).toEqual([5, 5, 5]);
      expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    });

    it('lands on the last page when asked for one past the end', async () => {
      const { items, page } = await getYesNoReferences({ page: 9 }, 2);
      expect(page).toBe(3);
      expect(items.map((i) => i.imageId)).toEqual([2]);
    });

    it('finds the pair for one image id, and nothing for an image without one', async () => {
      const found = await getYesNoReferences({ page: 1, imageId: 3 });
      expect(found.items.map((i) => i.imageId)).toEqual([3]);
      expect(found.total).toBe(1);
      expect(await getYesNoReferences({ page: 1, imageId: 99 })).toEqual({
        items: [],
        total: 0,
        page: 1,
      });
    });
  });
});
