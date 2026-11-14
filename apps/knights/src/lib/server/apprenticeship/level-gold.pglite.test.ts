import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { counterValue } from '../../../test/metrics';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
import { restartCareer } from '../career/restart.service';
import { PROGRESSION } from '../progression/config';
import { expForLevel } from '../progression/levels';
import { acolyteLevelGoldSince, acolyteLevelsGained, grantAcolyteLevelGold } from './level-gold';
import { answerApprentice, getApprentice, type ApprenticeDeps } from './apprenticeship.service';

const T0 = new Date('2026-12-25T12:00:00Z');
const GOLD = PROGRESSION.acolyteLevelGold;

let pg: PGlite;
let db: Kysely<DB>;
let now = T0;
const deps = (): ApprenticeDeps => ({ now: () => now, mirrorXp: vi.fn(async () => undefined) });

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsApprenticeAnswer","KnightsAcolyteLevelGold","KnightsReferenceImage","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
  );
  now = T0;
});

async function player(userId: number, o: { rank?: string; exp?: number } = {}) {
  await pg.query(
    `INSERT INTO "NewOrderPlayer" ("userId","rankType","exp","startAt") VALUES ($1,$2,$3,'2020-01-01')`,
    [userId, o.rank ?? 'Acolyte', o.exp ?? 0]
  );
}

async function reference(imageId: number) {
  await seedImage(pg, imageId);
  await pg.query(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","status") VALUES ($1,'trials','4','core','active')`,
    [imageId]
  );
}

async function answerRight(userId: number) {
  const view = await getApprentice(db, userId);
  if (view.kind !== 'question') throw new Error(`expected a question, got ${view.kind}`);
  const { item } = view;
  const { rows } = await pg.query<{ answer: string }>(
    `SELECT "answer" FROM "KnightsReferenceImage" WHERE "id"=$1`,
    [item.referenceId]
  );
  const result = await answerApprentice(
    db,
    {
      userId,
      kind: item.kind,
      referenceId: item.referenceId,
      version: item.version,
      answer: rows[0].answer,
    },
    deps()
  );
  now = new Date(now.getTime() + 1000);
  return result;
}

const goldEarned = async (userId: number) =>
  (
    await pg.query<{ goldEarned: number }>(
      `SELECT "goldEarned" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [userId]
    )
  ).rows[0].goldEarned;
const paidLevels = async (userId: number) =>
  (
    await pg.query<{ level: number }>(
      `SELECT "level" FROM "KnightsAcolyteLevelGold" WHERE "playerId"=$1 ORDER BY "level"`,
      [userId]
    )
  ).rows.map((row) => row.level);
const setExp = (userId: number, exp: number) =>
  pg.query(`UPDATE "NewOrderPlayer" SET "exp"=$2 WHERE "userId"=$1`, [userId, exp]);
const grant = (before: number, after: number) =>
  db
    .transaction()
    .execute((trx) => grantAcolyteLevelGold(trx, { playerId: 1, before, after, now: T0 }));

describe('acolyteLevelsGained', () => {
  it('lists each level gained from 2 up to level 20, and nothing past it', () => {
    expect(acolyteLevelsGained(1, 2)).toEqual([2]);
    expect(acolyteLevelsGained(3, 5)).toEqual([4, 5]);
    expect(acolyteLevelsGained(18, 24)).toEqual([19, 20]);
    expect(acolyteLevelsGained(20, 25)).toEqual([]);
    expect(acolyteLevelsGained(5, 5)).toEqual([]);
  });
});

describe('Acolyte level gold', () => {
  it('pays the configured gold once when an answer gains a level, in the same step as the XP', async () => {
    await player(1, { exp: expForLevel(2) - 100 });
    await reference(1);
    const before = await counterValue('knights_gold_earned_total', { source: 'acolyte_level' });

    const result = await answerRight(1);
    expect(await counterValue('knights_gold_earned_total', { source: 'acolyte_level' })).toBe(
      before + GOLD
    );

    expect(result).toMatchObject({ status: 'recorded', xp: 100, gold: GOLD });
    expect(await goldEarned(1)).toBe(GOLD);
    expect(await paidLevels(1)).toEqual([2]);
  });

  it('pays nothing for an answer that stays on its level', async () => {
    await player(1);
    await reference(1);

    expect(await answerRight(1)).toMatchObject({ status: 'recorded', gold: 0 });
    expect(await goldEarned(1)).toBe(0);
    expect(await paidLevels(1)).toEqual([]);
  });

  it('pays once per level gained when a rise skips levels, and not twice for the same level', async () => {
    await player(1);

    expect(await grant(1, 4)).toBe(3 * GOLD);
    expect(await paidLevels(1)).toEqual([2, 3, 4]);
    expect(await goldEarned(1)).toBe(3 * GOLD);

    expect(await grant(3, 5)).toBe(GOLD);
    expect(await goldEarned(1)).toBe(4 * GOLD);
  });

  it('pays nothing again for levels already paid after a career restart, and the notice shows only the new career', async () => {
    await player(1, { exp: expForLevel(2) - 100 });
    await reference(1);
    await reference(2);
    await answerRight(1);
    expect(await goldEarned(1)).toBe(GOLD);

    await restartCareer(db, 1, now);
    await pg.query(`UPDATE "NewOrderPlayer" SET "startAt"=$2 WHERE "userId"=$1`, [
      1,
      new Date(T0.getTime() + 86_400_000),
    ]);
    expect(await goldEarned(1)).toBe(0);
    expect(await acolyteLevelGoldSince(db, 1, 1, 5)).toBe(0);

    await setExp(1, expForLevel(2) - 100);
    expect(await answerRight(1)).toMatchObject({ status: 'recorded', gold: 0 });
    expect(await goldEarned(1)).toBe(0);
    expect(await paidLevels(1)).toEqual([2]);
  });

  it('reports the gold paid for levels in a range during the current career', async () => {
    await player(1);
    await grant(1, 4);

    expect(await acolyteLevelGoldSince(db, 1, 1, 4)).toBe(3 * GOLD);
    expect(await acolyteLevelGoldSince(db, 1, 2, 3)).toBe(GOLD);
    expect(await acolyteLevelGoldSince(db, 1, 4, 6)).toBe(0);
  });

  it('pays nothing for levels past 20 and nothing to a Knight', async () => {
    await player(1);
    expect(await grant(19, 23)).toBe(GOLD);
    expect(await grant(20, 30)).toBe(0);
    expect(await paidLevels(1)).toEqual([20]);

    await player(2, { rank: 'Knight', exp: expForLevel(25) - 100 });
    await reference(1);
    expect(
      await answerApprentice(db, { userId: 2, kind: 'rating', referenceId: 1, answer: '4' }, deps())
    ).toMatchObject({
      status: 'rejected',
      reason: 'not-acolyte',
    });
    expect(await goldEarned(2)).toBe(0);
    expect(await paidLevels(2)).toEqual([]);
  });
});
