import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyUserScoreUpdates, subtractImagesScores } from '~/server/jobs/update-user-score';
import {
  IMAGE_SELF_EXCLUDED_STAMP,
  listImageOwnersToExclude,
} from '~/server/services/creator-score-self-activity.service';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = { db: null as unknown as PGlite };
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;
const q = (sql: string, params?: unknown[]) => holder.db.query(sql, params);

const AT = new Date('2026-11-01T00:00:00.000Z');
const stamp = { key: IMAGE_SELF_EXCLUDED_STAMP, at: AT };

async function user(id: number, scores: Record<string, unknown>) {
  await q(`INSERT INTO "User" (id, meta) VALUES ($1, $2)`, [
    id,
    JSON.stringify({ other: 1, scores }),
  ]);
}
async function scoresOf(id: number) {
  const { rows } = await q(`SELECT meta FROM "User" WHERE id = $1`, [id]);
  return (rows[0] as { meta: { other: number; scores: Record<string, unknown> } }).meta;
}

beforeAll(async () => {
  holder.db = new PGlite();
  await q(`CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb)`);
});

beforeEach(async () => {
  await q(`TRUNCATE "User"`);
});

describe('subtractImagesScores', () => {
  it('takes the points off images, recomputes the total, stamps, and keeps the rest of meta', async () => {
    await user(1, { images: 1000, models: 500, total: 1500 });
    const [transition] = await subtractImagesScores(pg, [[1, 300]], stamp);
    expect(transition).toEqual({ userId: 1, oldTotal: 1500, newTotal: 1200 });
    const meta = await scoresOf(1);
    expect(meta.other).toBe(1);
    expect(meta.scores).toEqual({
      images: 700,
      models: 500,
      total: 1200,
      [IMAGE_SELF_EXCLUDED_STAMP]: AT.toISOString(),
    });
  });

  it('never takes images below zero', async () => {
    await user(1, { images: 100, models: 500, total: 600 });
    await subtractImagesScores(pg, [[1, 300]], stamp);
    expect((await scoresOf(1)).scores).toMatchObject({ images: 0, total: 500 });
  });

  it('subtracts once: a second run skips the stamped owner', async () => {
    await user(1, { images: 1000, total: 1000 });
    await subtractImagesScores(pg, [[1, 300]], stamp);
    expect(await subtractImagesScores(pg, [[1, 300]], stamp)).toEqual([]);
    expect((await scoresOf(1)).scores).toMatchObject({ images: 700, total: 700 });
  });

  it('subtracts from the score as it is when written, not as a caller read it', async () => {
    await user(1, { images: 1000, total: 1000 });
    await q(`UPDATE "User" SET meta = jsonb_set(meta, '{scores,images}', '1500') WHERE id = 1`);
    await subtractImagesScores(pg, [[1, 300]], stamp);
    expect((await scoresOf(1)).scores).toMatchObject({ images: 1200 });
  });
});

describe('applyUserScoreUpdates with a stamp', () => {
  it('writes the score and every stamp key in one statement, keeping sibling scores', async () => {
    await user(1, { images: 10, models: 5, total: 15 });
    await applyUserScoreUpdates(pg, [['1', { images: 40 }]], undefined, {
      stamp: { keys: ['imageScoreRecomputedAt', IMAGE_SELF_EXCLUDED_STAMP], at: AT },
    });
    expect((await scoresOf(1)).scores).toEqual({
      images: 40,
      models: 5,
      total: 45,
      imageScoreRecomputedAt: AT.toISOString(),
      [IMAGE_SELF_EXCLUDED_STAMP]: AT.toISOString(),
    });
  });

  it('refuses a stamp key that is not a plain word', async () => {
    await user(1, { images: 10, total: 10 });
    await expect(
      applyUserScoreUpdates(pg, [['1', { images: 40 }]], undefined, {
        stamp: { keys: ["x', 'y"], at: AT },
      })
    ).rejects.toThrow('invalid score stamp key');
  });
});

describe('listImageOwnersToExclude', () => {
  it('lists owners with an images score who are not stamped', async () => {
    await user(1, { images: 10 });
    await user(2, { images: 10, [IMAGE_SELF_EXCLUDED_STAMP]: AT.toISOString() });
    await user(3, { images: 0 });
    await user(4, { models: 10 });
    expect(await listImageOwnersToExclude(pg)).toEqual([1]);
  });
});
