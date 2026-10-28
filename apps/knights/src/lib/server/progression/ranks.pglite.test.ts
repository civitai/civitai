import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedGradedVotes, seedImage, seedPlayer } from '../../../test/seed';
import { getPlayerStatus } from '../player-status';
import {
  castVote,
  enqueueItem,
  ensureVotePartitions,
  type QueueDeps,
} from '../queue/queue.service';
import { PROGRESSION, RATING } from './config';
import { expForLevel } from './levels';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;
const deps: QueueDeps = {
  applyConsensus: vi.fn(async () => ({ outcome: 'applied' as const })),
  now: () => NOW,
  mirrorXp: vi.fn(async () => undefined),
};

type Setup = { level?: number; correct?: number; failed?: number };
async function player(userId: number, rank: string, { level = 1, correct, failed }: Setup = {}) {
  await seedPlayer(pg, userId, rank);
  await pg.query(`UPDATE "NewOrderPlayer" SET "exp"=$2 WHERE "userId"=$1`, [
    userId,
    expForLevel(level),
  ]);
  if (correct || failed) await seedGradedVotes(pg, userId, { correct, failed });
}

const rankOf = async (userId: number) =>
  (
    await pg.query<{ rankType: string }>(
      `SELECT "rankType" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [userId]
    )
  ).rows[0].rankType;

const ballot = async (itemId: number, userId: number) =>
  (
    await pg.query<{ weight: number; gold: number }>(
      `SELECT weight, gold FROM "KnightsVote" WHERE "itemId"=$1 AND "playerId"=$2`,
      [itemId, userId]
    )
  ).rows[0];

let nextImage = 100;
async function newItem(): Promise<number> {
  const imageId = nextImage++;
  await seedImage(pg, imageId, { nsfwLevel: 4 });
  return enqueueItem(db, { questionKey: Q, imageId, source: 'test', expiresAt: null }, NOW);
}

/** The first player votes with the crowd on a new item, so their vote is graded correct. */
async function settleCorrect(userId: number) {
  const itemId = await newItem();
  for (let i = 0; i < 4; i++) {
    const voter = 9000 + i;
    await player(voter, 'Knight');
    await castVote(db, { userId: voter, itemId, answer: '4' }, deps);
  }
  await castVote(db, { userId, itemId, answer: '4' }, deps);
}

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY`
  );
});

describe('rank-up when votes settle', () => {
  it('needs the level as well as the accuracy bar', async () => {
    await player(1, 'Knight', { level: 20, correct: 100 });
    await settleCorrect(1);
    expect(await rankOf(1)).toBe('Knight');
  });

  it('needs the accuracy bar as well as the level', async () => {
    await player(1, 'Knight', { level: 25, correct: 30, failed: 30 });
    await settleCorrect(1);
    expect(await rankOf(1)).toBe('Knight');
  });

  it('promotes when both are met, counting the XP that settle adds', async () => {
    await player(1, 'Knight', { level: 21, correct: 100 });
    await pg.query(`UPDATE "NewOrderPlayer" SET "exp"=$1 WHERE "userId"=1`, [
      expForLevel(21) - PROGRESSION.voteXp - PROGRESSION.correctXp,
    ]);
    await settleCorrect(1);
    expect(await rankOf(1)).toBe('Templar');
  });

  it('can skip Templar', async () => {
    await player(1, 'Knight', { level: 45, correct: 100 });
    await settleCorrect(1);
    expect(await rankOf(1)).toBe('Paladin');
  });

  it('does not rank anyone up before the sample is big enough to rate them', async () => {
    await player(1, 'Knight', { level: 30, correct: RATING.minGraded - 2 });
    await settleCorrect(1);
    expect(await rankOf(1)).toBe('Knight');
  });

  it('promotes a player already past the Templar level the first time they pass the bar', async () => {
    await player(1, 'Knight', { level: 30, correct: RATING.minGraded - 1 });
    await settleCorrect(1);
    expect(await rankOf(1)).toBe('Templar');
  });
});

describe('below the bar of one rank', () => {
  const weightOf = async (userId: number, setup: Setup, rank = 'Knight') => {
    await player(userId, rank, setup);
    const itemId = await newItem();
    await castVote(db, { userId, itemId, answer: '4' }, deps);
    return { ...(await ballot(itemId, userId)), itemId };
  };

  it('halves vote weight and gold, and keeps rank and level', async () => {
    const fine = await weightOf(1, { correct: 35, failed: 15 });
    const low = await weightOf(2, { correct: 34, failed: 16 });

    expect(fine.gold).toBe(PROGRESSION.baseGold);
    expect(low.gold).toBe(PROGRESSION.baseGold * 0.5);
    expect(low.weight).toBeCloseTo(fine.weight * 0.5, 1);
    expect(await rankOf(2)).toBe('Knight');
    const pending = await pg.query<{ goldPending: number }>(
      `SELECT "goldPending" FROM "NewOrderPlayer" WHERE "userId"=2`
    );
    expect(pending.rows[0].goldPending).toBe(PROGRESSION.baseGold * 0.5);
  });

  it('does not apply before the player is rated', async () => {
    const unrated = await weightOf(1, { failed: RATING.minGraded - 1 });
    expect(unrated.gold).toBe(PROGRESSION.baseGold);
  });

  it('uses the bar of the player own rank', async () => {
    const templar = await weightOf(1, { level: 25, correct: 38, failed: 12 }, 'Templar');
    expect(templar.gold).toBe(Math.round(PROGRESSION.baseGold * 1.25 * 0.5));
    const ok = await weightOf(2, { level: 25, correct: 40, failed: 10 }, 'Templar');
    expect(ok.gold).toBe(Math.round(PROGRESSION.baseGold * 1.25));
  });
});

describe('status', () => {
  it('shows the accuracy, the bar and whether the player is below it', async () => {
    await player(1, 'Knight', { correct: 30, failed: 30 });
    expect((await getPlayerStatus(db, 1))?.rating).toMatchObject({
      graded: 60,
      minGraded: RATING.minGraded,
      accuracy: 0.5,
      bar: 0.7,
      belowBar: true,
    });
  });

  it('shows the graded count instead of an accuracy until rated', async () => {
    await player(1, 'Knight', { correct: 10, failed: 2 });
    expect((await getPlayerStatus(db, 1))?.rating).toMatchObject({
      graded: 12,
      accuracy: null,
      belowBar: false,
    });
  });

  it('shows what the next rank needs and how far the player is', async () => {
    await player(1, 'Knight', { level: 18, correct: 45, failed: 5 });
    expect((await getPlayerStatus(db, 1))?.nextRank).toEqual({
      rank: 'Templar',
      fromLevel: 21,
      accuracyBar: 0.8,
      levelsToGo: 3,
      levelMet: false,
      accuracyMet: true,
    });
  });

  it('has no next rank for a Paladin', async () => {
    await player(1, 'Paladin', { level: 50 });
    expect((await getPlayerStatus(db, 1))?.nextRank).toBeNull();
  });
});
