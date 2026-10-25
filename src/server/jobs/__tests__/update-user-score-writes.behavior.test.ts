import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyUserScoreUpdates,
  raiseImagesScores,
  subtractImagesScores,
} from '~/server/jobs/update-user-score';
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
  await q(`CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb)`);
});

beforeEach(async () => {
  await q(`TRUNCATE "User", "KeyValue"`);
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

describe('raiseImagesScores', () => {
  const CHECKPOINT = { key: 'update-user-score:images', value: 1_792_886_169_000 };
  const raised = { key: 'imageScoreRaisedAt', at: AT };
  const setCheckpoint = (value: number) =>
    q(
      `INSERT INTO "KeyValue" VALUES ($1, to_jsonb($2::bigint))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [CHECKPOINT.key, value]
    );
  const raise = (rows: { id: number; expected: number | null; next: number }[]) =>
    raiseImagesScores(pg, rows, { checkpoint: CHECKPOINT, stamp: raised });

  beforeEach(() => setCheckpoint(CHECKPOINT.value));

  it('raises images, recomputes the total, stamps, and returns both sides', async () => {
    await user(1, { images: 100, models: 50, total: 150 });
    const [row] = await raise([{ id: 1, expected: 100, next: 400 }]);
    expect(row).toEqual({
      userId: 1,
      oldImages: 100,
      newImages: 400,
      oldTotal: 150,
      newTotal: 450,
    });
    expect((await scoresOf(1)).scores).toEqual({
      images: 400,
      models: 50,
      total: 450,
      imageScoreRaisedAt: AT.toISOString(),
    });
  });

  it('gives an owner with no images score one', async () => {
    await user(1, { models: 50, total: 50 });
    await raise([{ id: 1, expected: null, next: 30 }]);
    expect((await scoresOf(1)).scores).toMatchObject({ images: 30, total: 80 });
  });

  // The cron persisted a new score after the caller read it: writing the caller's value would drop it.
  it('writes nothing where the score is no longer the one the caller read', async () => {
    await user(1, { images: 100, total: 100 });
    await q(`UPDATE "User" SET meta = jsonb_set(meta, '{scores,images}', '130') WHERE id = 1`);
    expect(await raise([{ id: 1, expected: 100, next: 400 }])).toEqual([]);
    expect((await scoresOf(1)).scores).toMatchObject({ images: 130, total: 100 });
  });

  // The cron finished a run after the caller read the checkpoint: the value is as of the old one.
  it('writes nothing once the checkpoint has moved', async () => {
    await user(1, { images: 100, total: 100 });
    await setCheckpoint(CHECKPOINT.value + 86_400_000);
    expect(await raise([{ id: 1, expected: 100, next: 400 }])).toEqual([]);
    expect((await scoresOf(1)).scores).toMatchObject({ images: 100 });
  });

  it('never lowers a score, whatever the caller asks', async () => {
    await user(1, { images: 100, total: 100 });
    expect(
      await raise([
        { id: 1, expected: 100, next: 40 },
        { id: 1, expected: 100, next: 100 },
      ])
    ).toEqual([]);
    expect((await scoresOf(1)).scores).toMatchObject({ images: 100 });
  });

  it('is taken back exactly by subtracting what it added, keeping what the cron added since', async () => {
    await user(1, { images: 100, total: 100 });
    const [row] = await raise([{ id: 1, expected: 100, next: 400 }]);
    await q(`UPDATE "User" SET meta = jsonb_set(meta, '{scores,images}', '420') WHERE id = 1`);
    await subtractImagesScores(pg, [[1, Number(row.newImages) - Number(row.oldImages)]], {
      key: 'imageScoreRaiseRolledBackAt',
      at: AT,
    });
    expect((await scoresOf(1)).scores).toMatchObject({ images: 120 });
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
