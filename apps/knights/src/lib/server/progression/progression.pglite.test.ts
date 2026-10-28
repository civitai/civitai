import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import {
  applyPendingResolutions,
  castVote,
  closeWithoutOutcome,
  enqueueItem,
  ensureVotePartitions,
  type QueueDeps,
} from '../queue/queue.service';
import { PROGRESSION } from './config';
import { calculateFervor, settleFinalItems, settleItemVotes } from './progression';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;
const applyConsensus = vi.fn<QueueDeps['applyConsensus']>(async () => ({ outcome: 'applied' }));
const deps: QueueDeps = { applyConsensus, now: () => NOW };

async function player(userId: number, rankType = 'Knight', extra = '') {
  await pg.query(`INSERT INTO "NewOrderPlayer" ("userId","rankType") VALUES ($1,$2)`, [
    userId,
    rankType,
  ]);
  if (extra) await pg.exec(`UPDATE "NewOrderPlayer" SET ${extra} WHERE "userId"=${userId}`);
}

async function image(id: number, nsfwLevel = 4) {
  await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,'2020-01-01')`, [id]);
  await pg.query(`INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES ($1,$2,$3,$1)`, [
    id,
    `key-${id}`,
    nsfwLevel,
  ]);
}

const item = (imageId: number, question = Q) =>
  enqueueItem(db, { questionKey: question, imageId, source: 'test', expiresAt: null }, NOW);

const vote = (userId: number, itemId: number, answer: string) =>
  castVote(db, { userId, itemId, answer }, deps);

const who = async (userId: number) =>
  (
    await pg.query<{ exp: number; fervor: number; goldPending: number; goldEarned: number }>(
      `SELECT "exp","fervor","goldPending","goldEarned" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [userId]
    )
  ).rows[0];

const ballot = async (itemId: number, userId: number) =>
  (
    await pg.query<{ verdict: string; xp: number; gold: number | null; settledAt: Date | null }>(
      `SELECT verdict, xp, gold, "settledAt" FROM "KnightsVote" WHERE "itemId"=$1 AND "playerId"=$2`,
      [itemId, userId]
    )
  ).rows[0];

/** Five Knights vote; the last `losers` of them pick the other answer. */
async function resolve(itemId: number, firstPlayer: number, winning: string, losers = 0) {
  const other = winning === '4' ? '8' : '4';
  for (let i = 0; i < 5; i++) {
    await vote(firstPlayer + i, itemId, i < 5 - losers ? winning : other);
  }
}

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  applyConsensus.mockClear();
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY`
  );
});

describe('vote time', () => {
  it('pays flat XP at once and holds the vote gold as pending', async () => {
    await player(1);
    await image(10);
    const id = await item(10);

    await vote(1, id, '4');

    expect(await who(1)).toMatchObject({
      exp: PROGRESSION.voteXp,
      goldPending: PROGRESSION.baseGold,
      goldEarned: 0,
    });
    expect(await ballot(id, 1)).toMatchObject({
      verdict: 'pending',
      xp: PROGRESSION.voteXp,
      gold: PROGRESSION.baseGold,
      settledAt: null,
    });
  });

  it('scales pending gold by the voter rank', async () => {
    await player(1, 'Templar');
    await player(2, 'Paladin');
    await image(10);
    const id = await item(10);
    await vote(1, id, '4');
    await vote(2, id, '4');

    expect((await who(1)).goldPending).toBe(125);
    expect((await who(2)).goldPending).toBe(150);
  });
});

describe('grading', () => {
  it('pays the bulk and earns the gold of a correct vote, and drops the gold of a wrong one', async () => {
    for (let i = 1; i <= 5; i++) await player(i);
    await image(10);
    const id = await item(10);
    await resolve(id, 1, '4', 1);

    expect(await who(1)).toMatchObject({
      exp: PROGRESSION.voteXp + PROGRESSION.correctXp,
      goldPending: 0,
      goldEarned: PROGRESSION.baseGold,
    });
    expect(await ballot(id, 1)).toMatchObject({ verdict: 'correct', gold: PROGRESSION.baseGold });
    expect((await ballot(id, 1)).settledAt).not.toBeNull();

    expect(await who(5)).toMatchObject({
      exp: PROGRESSION.voteXp,
      goldPending: 0,
      goldEarned: 0,
      fervor: 0,
    });
    expect(await ballot(id, 5)).toMatchObject({
      verdict: 'failed',
      gold: 0,
      xp: PROGRESSION.voteXp,
    });
  });

  it('earns the rank multiplier on a correct vote', async () => {
    await player(1, 'Templar');
    for (let i = 2; i <= 5; i++) await player(i);
    await image(10);
    const id = await item(10);
    await resolve(id, 1, '4');

    expect((await who(1)).goldEarned).toBe(125);
  });

  it('keeps the gold of a player with a payout block, as earned', async () => {
    await player(1, 'Knight', `"payoutBlockedAt"=now(), "payoutBlockReason"='held'`);
    for (let i = 2; i <= 5; i++) await player(i);
    await image(10);
    const id = await item(10);
    await resolve(id, 1, '4');

    expect(await who(1)).toMatchObject({ goldPending: 0, goldEarned: PROGRESSION.baseGold });
  });

  it('computes fervor from correct votes and accuracy', async () => {
    for (let i = 1; i <= 5; i++) await player(i);
    await image(10);
    await image(11);
    const first = await item(10);
    const second = await item(11);
    await resolve(first, 1, '4');
    await resolve(second, 1, '8', 1);

    // Player 1 got both right; player 5 agreed with the first ruling and lost the second.
    expect((await who(1)).fervor).toBe(calculateFervor({ correct: 2, graded: 2 }));
    expect((await who(5)).fervor).toBe(calculateFervor({ correct: 1, graded: 2 }));
    expect((await who(5)).fervor).toBe(50);
  });

  it('gives inconclusive votes no bulk, no gold and no weight in fervor', async () => {
    await player(1);
    await image(10);
    const id = await item(10);
    await vote(1, id, '4');
    await closeWithoutOutcome(db, id, NOW);

    expect(await ballot(id, 1)).toMatchObject({ verdict: 'inconclusive', gold: 0 });
    expect(await who(1)).toMatchObject({
      exp: PROGRESSION.voteXp,
      goldPending: 0,
      goldEarned: 0,
      fervor: 0,
    });
  });

  it('is idempotent: settling or sweeping an item again pays nothing more', async () => {
    for (let i = 1; i <= 5; i++) await player(i);
    await image(10);
    const id = await item(10);
    await resolve(id, 1, '4');
    const before = await who(1);

    expect(await settleItemVotes(db, id, NOW)).toBe(0);
    expect(await settleFinalItems(db, { now: NOW })).toEqual({ items: 0, votes: 0 });
    await applyPendingResolutions(db, deps);

    expect(await who(1)).toEqual(before);
  });

  it('waits for the rating write-back before paying out, then pays once', async () => {
    for (let i = 1; i <= 5; i++) await player(i);
    await image(10, 4);
    const id = await item(10);
    applyConsensus.mockRejectedValueOnce(new Error('main app down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await resolve(id, 1, '8');
    expect(await who(1)).toMatchObject({
      exp: PROGRESSION.voteXp,
      goldPending: PROGRESSION.baseGold,
    });
    expect((await ballot(id, 1)).settledAt).toBeNull();

    await pg.exec(`UPDATE "KnightsQueueItem" SET "nextAttemptAt"=NULL`);
    await applyPendingResolutions(db, deps);

    expect(await who(1)).toMatchObject({
      exp: PROGRESSION.voteXp + PROGRESSION.correctXp,
      goldEarned: PROGRESSION.baseGold,
    });
  });

  it('sweeps an item closed by another app that graded its votes', async () => {
    await player(1);
    await player(2);
    await image(10);
    const id = await item(10);
    await vote(1, id, '4');
    await vote(2, id, '8');
    // What a moderator ruling does: close the item and grade its pending votes.
    await pg.exec(`UPDATE "KnightsQueueItem" SET status='Closed' WHERE id=${id}`);
    await pg.exec(
      `UPDATE "KnightsVote" SET verdict = CASE WHEN answer='8' THEN 'correct' ELSE 'failed' END`
    );

    expect(await settleFinalItems(db, { now: NOW })).toEqual({ items: 1, votes: 2 });
    expect(await who(2)).toMatchObject({ goldEarned: PROGRESSION.baseGold, goldPending: 0 });
    expect(await who(1)).toMatchObject({ goldEarned: 0, goldPending: 0 });
  });
});

describe('calculateFervor', () => {
  it('is 0 with nothing graded and floors accuracy', () => {
    expect(calculateFervor({ correct: 0, graded: 0 })).toBe(0);
    expect(calculateFervor({ correct: 10, graded: 500 })).toBe(
      Math.floor(10 * PROGRESSION.fervorPerCorrect * PROGRESSION.fervorAccuracyFloor)
    );
    expect(calculateFervor({ correct: 400, graded: 500 })).toBe(32000);
  });
});
