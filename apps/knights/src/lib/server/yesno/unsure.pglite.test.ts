import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
import { importYesNo } from './import';
import { recordUnsure } from './unsure';

const NOW = new Date('2026-12-21T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;
let itemIds: Record<string, number>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsUnsure","KnightsQueueItem","Image","Post" RESTART IDENTITY CASCADE; DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%'`
  );
  for (const imageId of [500, 501]) await seedImage(pg, imageId, { nsfwLevel: 8 });
  await importYesNo(db, [
    {
      externalId: 'a',
      imageId: 500,
      axis: 'violence',
      audience: 'players',
      prompt: 'Is there blood?',
      yesEffect: 'R4',
      noEffect: 'R3',
      meta: {},
    },
    {
      externalId: 'b',
      imageId: 501,
      axis: 'violence',
      audience: 'players',
      prompt: 'Is a weapon shown?',
      yesEffect: 'R4',
      noEffect: 'R3',
      meta: {},
    },
  ]);
  itemIds = Object.fromEntries(
    (
      await pg.query<{ id: number; externalId: string }>(
        `SELECT id, "externalId" FROM "KnightsQueueItem"`
      )
    ).rows.map((r) => [r.externalId, r.id])
  );
});

const perQuestion = async () =>
  (
    await pg.query<{ itemId: number; questionKey: string; imageId: number; n: number }>(
      `SELECT "itemId", "questionKey", "imageId", count(*)::int AS n FROM "KnightsUnsure" GROUP BY 1, 2, 3 ORDER BY 1`
    )
  ).rows;

describe('recordUnsure', () => {
  it("stores one row per player and question, with the item's question key and image, countable per question", async () => {
    expect(await recordUnsure(db, { playerId: 1, itemId: itemIds.a, now: NOW })).toBe(true);
    expect(await recordUnsure(db, { playerId: 2, itemId: itemIds.a, now: NOW })).toBe(true);
    expect(await recordUnsure(db, { playerId: 1, itemId: itemIds.b, now: NOW })).toBe(true);

    const [question] = (
      await pg.query<{ questionKey: string }>(
        `SELECT "questionKey" FROM "KnightsQueueItem" WHERE id = $1`,
        [itemIds.a]
      )
    ).rows;
    expect(await perQuestion()).toEqual([
      { itemId: itemIds.a, questionKey: question.questionKey, imageId: 500, n: 2 },
      { itemId: itemIds.b, questionKey: question.questionKey, imageId: 501, n: 1 },
    ]);
  });

  it('counts a player once per question when the same Not sure is sent again', async () => {
    await recordUnsure(db, { playerId: 1, itemId: itemIds.a, now: NOW });
    expect(await recordUnsure(db, { playerId: 1, itemId: itemIds.a, now: NOW })).toBe(false);
    expect(await perQuestion()).toEqual([expect.objectContaining({ itemId: itemIds.a, n: 1 })]);
  });

  it('stores nothing for a question that is no longer open', async () => {
    await pg.query(`UPDATE "KnightsQueueItem" SET status = 'Closed' WHERE id = $1`, [itemIds.a]);
    expect(await recordUnsure(db, { playerId: 1, itemId: itemIds.a, now: NOW })).toBe(false);
    expect(await perQuestion()).toEqual([]);
  });

  it('stores nothing for an item that does not exist', async () => {
    expect(await recordUnsure(db, { playerId: 1, itemId: 999_999, now: NOW })).toBe(false);
    expect(await perQuestion()).toEqual([]);
  });

  it('never throws: a store that fails is logged and reported as not recorded', async () => {
    const broken = {
      insertInto: () => {
        throw new Error('permission denied for table KnightsUnsure');
      },
    } as unknown as Kysely<DB>;
    expect(await recordUnsure(broken, { playerId: 1, itemId: itemIds.a, now: NOW })).toBe(false);
  });
});
