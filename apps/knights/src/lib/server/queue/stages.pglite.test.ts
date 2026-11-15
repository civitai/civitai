import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { createQueueDb } from '../../../test/pglite-kysely';
import {
  castVote,
  enqueueItem,
  ensureVotePartitions,
  escalateExpired,
  getFeed,
  type QueueDeps,
} from './queue.service';
import { FEED } from './feed';

const Q = KNIGHTS_NSFW_LEVEL_QUESTION;
const NOW = new Date('2026-12-15T12:00:00Z');
const hoursAfter = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

let pg: PGlite;
let db: Kysely<DB>;
const applyConsensus = vi.fn<QueueDeps['applyConsensus']>(async () => ({ outcome: 'applied' }));
const deps: QueueDeps = { applyConsensus, now: () => NOW };

async function player(userId: number, rankType: string) {
  await pg.query(`INSERT INTO "NewOrderPlayer" ("userId","rankType") VALUES ($1,$2)`, [
    userId,
    rankType,
  ]);
}
/** A player who voted recently, which is what makes a rank count as served when an item is handed up. */
async function active(userId: number, rankType: string) {
  await player(userId, rankType);
  await pg.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
     VALUES ($1,$2,$3,$4,0,'Knight','4',1)`,
    [-userId, userId, NOW, Q]
  );
}
const players = async (rank: string, from: number, count: number) => {
  for (let i = 0; i < count; i++) await player(from + i, rank);
};

async function image(id: number, nsfwLevel = 4) {
  await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,'2020-01-01')`, [id]);
  await pg.query(`INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES ($1,$2,$3,$1)`, [
    id,
    `key-${id}`,
    nsfwLevel,
  ]);
}

async function item(
  imageId: number,
  o: { minRank?: string; priority?: number; at?: Date; prediction?: unknown } = {}
) {
  const id = await enqueueItem(
    db,
    {
      questionKey: Q,
      imageId,
      source: 'test',
      minRank: o.minRank,
      priority: o.priority,
      expiresAt: null,
    },
    o.at ?? NOW
  );
  if (o.prediction !== undefined) {
    await pg.query(`UPDATE "KnightsQueueItem" SET prediction = $2::jsonb WHERE id = $1`, [
      id,
      JSON.stringify(o.prediction),
    ]);
  }
  return id;
}

const itemRow = async (id: number) =>
  (await pg.query<Record<string, unknown>>(`SELECT * FROM "KnightsQueueItem" WHERE id=$1`, [id]))
    .rows[0];
const verdicts = async (id: number) =>
  (
    await pg.query<{ verdict: string; stage: string }>(
      `SELECT verdict, stage FROM "KnightsVote" WHERE "itemId"=$1 ORDER BY "playerId"`,
      [id]
    )
  ).rows;

const vote = (userId: number, itemId: number, answer: string) =>
  castVote(db, { userId, itemId, answer }, deps);

/** The first player votes the first answer, and so on; returns the last outcome. */
async function voteAll(first: number, itemId: number, answers: string[]) {
  let last = '';
  for (let i = 0; i < answers.length; i++)
    last = (await vote(first + i, itemId, answers[i])).status;
  return last;
}

/** A vote the player cast earlier, written straight into the ledger. */
async function judged(playerId: number, imageId: number, minutesAgo = 5, itemId = -imageId) {
  await pg.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
     VALUES ($1,$2,$3,$4,$5,'Knight','4',1)`,
    [itemId, playerId, new Date(NOW.getTime() - minutesAgo * 60_000), Q, imageId]
  );
}

const SPLIT10 = ['4', '1', '2', '8', '16', '4', '1', '2', '8', '16'];

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
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
  );
});

describe('stage consensus and escalation', () => {
  it('settles a Knight stage at four unanimous votes', async () => {
    await players('Knight', 1, 4);
    await image(10);
    const id = await item(10);

    expect(await voteAll(1, id, ['4', '4', '4', '4'])).toBe('resolved');
    expect(await itemRow(id)).toMatchObject({ status: 'Resolved', resolvedValue: '4' });
  });

  it('keeps a Knight 3-1 split open at four votes and settles it at 4 of 5', async () => {
    await players('Knight', 1, 5);
    await image(10);
    const id = await item(10);

    expect(await voteAll(1, id, ['4', '4', '8', '4'])).toBe('recorded');
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Knight' });

    expect((await vote(5, id, '4')).status).toBe('resolved');
    expect(await itemRow(id)).toMatchObject({ status: 'Resolved', resolvedValue: '4' });
  });

  it('keeps collecting past four Knight votes and sends a split at ten to the Templars', async () => {
    await players('Knight', 1, 10);
    await active(90, 'Templar');
    await image(10);
    const id = await item(10);

    expect(await voteAll(1, id, SPLIT10.slice(0, 9))).toBe('recorded');
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Knight' });

    expect((await vote(10, id, SPLIT10[9])).status).toBe('escalated');
    expect(await itemRow(id)).toMatchObject({
      status: 'Open',
      minRank: 'Templar',
      votesNeeded: 3,
      escalatedAt: NOW,
    });
  });

  it('settles a Templar stage at three unanimous votes', async () => {
    await players('Templar', 1, 3);
    await image(10);
    const id = await item(10, { minRank: 'Templar' });

    expect((await vote(1, id, '4')).status).toBe('recorded');
    expect((await vote(2, id, '4')).status).toBe('recorded');
    expect((await vote(3, id, '4')).status).toBe('resolved');
    expect(await itemRow(id)).toMatchObject({ status: 'Resolved', resolvedValue: '4' });
  });

  it('keeps a Templar 2-1 split open at three votes', async () => {
    await players('Templar', 1, 3);
    await image(10);
    const id = await item(10, { minRank: 'Templar' });

    expect(await voteAll(1, id, ['4', '8', '4'])).toBe('recorded');
    expect(await itemRow(id)).toMatchObject({ status: 'Open', minRank: 'Templar' });
  });

  it('sends a Templar split at six votes to the Paladins', async () => {
    await players('Templar', 1, 6);
    await active(91, 'Paladin');
    await image(10);
    const id = await item(10, { minRank: 'Templar' });

    expect(await voteAll(1, id, ['1', '2', '4', '1', '2', '4'])).toBe('escalated');
    expect(await itemRow(id)).toMatchObject({
      status: 'Open',
      minRank: 'Paladin',
      votesNeeded: 2,
      escalatedAt: NOW,
    });
  });

  it('settles a Paladin stage on two unanimous votes', async () => {
    await players('Paladin', 1, 2);
    await image(10);
    const id = await item(10, { minRank: 'Paladin' });

    expect(await voteAll(1, id, ['4', '4'])).toBe('resolved');
    expect(applyConsensus).toHaveBeenCalledTimes(1);
  });

  it('keeps a split Paladin stage open to four votes and settles it at 75%', async () => {
    await players('Paladin', 1, 4);
    await image(10);
    const id = await item(10, { minRank: 'Paladin' });

    expect(await voteAll(1, id, ['4', '8', '4'])).toBe('recorded');
    expect((await vote(4, id, '4')).status).toBe('resolved');
    expect(await itemRow(id)).toMatchObject({ status: 'Resolved', resolvedValue: '4' });
  });

  it('hands a Paladin split at four votes to the moderators and applies nothing', async () => {
    await players('Paladin', 1, 4);
    await image(10);
    const id = await item(10, { minRank: 'Paladin' });

    expect(await voteAll(1, id, ['4', '8', '4', '8'])).toBe('inquisitor');
    expect(await itemRow(id)).toMatchObject({
      status: 'Inquisitor',
      minRank: 'Inquisitor',
      questionKey: Q,
      escalationReason: 'no-consensus',
    });
    expect(applyConsensus).not.toHaveBeenCalled();
    expect((await verdicts(id)).every((v) => v.verdict === 'pending')).toBe(true);
  });

  it('counts only the votes cast at the item stage, and grades the earlier ones at the end', async () => {
    await players('Templar', 1, 3);
    await image(10);
    const id = await item(10, { minRank: 'Templar' });
    for (let p = 101; p <= 106; p++) {
      await pg.query(
        `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
         VALUES ($1,$2,$3,$4,10,'Knight','4',1)`,
        [id, p, NOW, Q]
      );
    }

    expect((await vote(1, id, '4')).status).toBe('recorded');
    expect((await vote(2, id, '4')).status).toBe('recorded');
    expect((await vote(3, id, '4')).status).toBe('resolved');

    const graded = await verdicts(id);
    expect(graded.filter((v) => v.stage === 'Knight')).toHaveLength(6);
    expect(graded.every((v) => v.verdict === 'correct')).toBe(true);
  });

  it('walks Knight, Templar, Paladin and out to the moderators one stage at a time', async () => {
    await players('Knight', 1, 10);
    for (let u = 21; u < 27; u++) await active(u, 'Templar');
    for (let u = 41; u < 45; u++) await active(u, 'Paladin');
    await image(10);
    const id = await item(10);

    expect(await voteAll(1, id, SPLIT10)).toBe('escalated');
    expect(await voteAll(21, id, ['1', '2', '4', '1', '2', '4'])).toBe('escalated');
    expect(await itemRow(id)).toMatchObject({ minRank: 'Paladin' });
    expect(await voteAll(41, id, ['4', '8', '4', '8'])).toBe('inquisitor');
    expect(await itemRow(id)).toMatchObject({ status: 'Inquisitor' });
    expect((await verdicts(id)).map((v) => v.stage)).toEqual([
      ...Array(10).fill('Knight'),
      ...Array(6).fill('Templar'),
      ...Array(4).fill('Paladin'),
    ]);
  });

  it('moves an item that sat out its stage with a vote up one stage, as an escalation', async () => {
    await player(1, 'Knight');
    await active(2, 'Templar');
    await image(10);
    const id = await enqueueItem(
      db,
      { questionKey: Q, imageId: 10, source: 'test', expiresAt: NOW },
      NOW
    );
    await vote(1, id, '4');
    expect(await escalateExpired(db, { now: hoursAfter(1) })).toEqual({
      escalated: 1,
      toInquisitor: 0,
      extended: 0,
      expired: 0,
    });
    expect(await itemRow(id)).toMatchObject({
      minRank: 'Templar',
      votesNeeded: 3,
      escalatedAt: hoursAfter(1),
    });
  });
});

describe('feed serving rules', () => {
  const feedIds = async (userId: number, o: Parameters<typeof getFeed>[2] = {}) =>
    (await getFeed(db, userId, { random: () => 0.99, now: NOW, ...o }))?.items.map((i) => i.id);

  it('serves an escalated item first while its priority lasts, and normally after', async () => {
    await player(1, 'Templar');
    await image(10);
    await image(11);
    const normal = await item(10, { minRank: 'Templar', priority: 1, at: hoursAfter(-48) });
    const escalated = await item(11, { minRank: 'Templar', priority: 3, at: hoursAfter(-1) });
    await pg.query(`UPDATE "KnightsQueueItem" SET "escalatedAt" = $2 WHERE id = $1`, [
      escalated,
      NOW,
    ]);

    expect(await feedIds(1, { now: hoursAfter(23) })).toEqual([escalated, normal]);
    expect(await feedIds(1, { now: hoursAfter(25) })).toEqual([normal, escalated]);
  });

  it('never serves an image the player already judged for the question', async () => {
    await players('Knight', 1, 2);
    await image(10);
    await image(11);
    const first = await item(10);
    await vote(1, first, '4');
    await pg.query(`UPDATE "KnightsQueueItem" SET status='Closed' WHERE id=$1`, [first]);
    const requeued = await item(10);
    const other = await item(11);

    expect(await feedIds(1)).toEqual([other]);
    expect((await feedIds(2))?.sort()).toEqual([requeued, other].sort());
  });

  it('keeps a Templar away from an item they already voted on at the Knight stage', async () => {
    await players('Knight', 1, 9);
    await players('Templar', 20, 2);
    await image(10);
    const id = await item(10);
    await voteAll(1, id, SPLIT10.slice(0, 9));
    await vote(20, id, SPLIT10[9]);

    expect((await itemRow(id)).minRank).toBe('Templar');
    expect(await feedIds(20)).toBeUndefined();
    expect(await feedIds(21)).toEqual([id]);
  });

  it('does not count a judgment of another question', async () => {
    await player(1, 'Knight');
    await image(10);
    const id = await item(10);
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
       VALUES (-10,1,$1,'knights.other',10,'Knight','yes',1)`,
      [NOW]
    );
    expect(await feedIds(1)).toEqual([id]);
  });

  describe('level buckets', () => {
    async function threeRecentRs(playerId: number) {
      for (const imageId of [90, 91, 92]) {
        await image(imageId, 4);
        await judged(playerId, imageId);
      }
    }

    it('serves a different level bucket than the last judged ones', async () => {
      await player(1, 'Knight');
      await threeRecentRs(1);
      await image(10, 4);
      await image(11, 4);
      await image(12, 8);
      await item(10, { at: hoursAfter(-3) });
      await item(11, { at: hoursAfter(-2) });
      const x = await item(12, { at: hoursAfter(-1) });

      expect(await feedIds(1, { limit: 1 })).toEqual([x]);
    });

    it('avoids only buckets judged within the recent window', async () => {
      await player(1, 'Knight');
      await image(10, 4);
      await image(11, 8);
      const r = await item(10, { at: hoursAfter(-3) });
      const x = await item(11, { at: hoursAfter(-1) });
      // 0.2 draws the first open bucket (R) when nothing is avoided, and is above the starvation share.
      const drawR = { limit: 1, random: () => 0.2 };

      for (const imageId of [90, 91, 92]) {
        await image(imageId, 4);
        await judged(1, imageId, (FEED.recentJudgedHours + 1) * 60);
      }
      expect(await feedIds(1, drawR)).toEqual([r]);

      for (const imageId of [93, 94, 95]) {
        await image(imageId, 4);
        await judged(1, imageId);
      }
      expect(await feedIds(1, drawR)).toEqual([x]);
    });

    it('buckets an item by its prediction before the image level', async () => {
      await player(1, 'Knight');
      for (const imageId of [90, 91, 92]) {
        await image(imageId, 8);
        await judged(1, imageId);
      }
      await image(10, 4);
      await image(11, 4);
      await item(10, { at: hoursAfter(-3), prediction: { value: '8' } });
      const r = await item(11, { at: hoursAfter(-2) });

      expect(await feedIds(1, { limit: 1 })).toEqual([r]);
    });

    it('still serves something when every bucket was judged lately', async () => {
      await player(1, 'Knight');
      await threeRecentRs(1);
      await image(10, 4);
      await image(11, 4);
      await item(10, { at: hoursAfter(-3) });
      await item(11, { at: hoursAfter(-2) });

      expect(await feedIds(1, { limit: 1 })).toHaveLength(1);
    });

    it('takes the oldest item of the chosen bucket when the starvation draw lands', async () => {
      await player(1, 'Knight');
      await threeRecentRs(1);
      await image(10, 4);
      await image(11, 8);
      await image(12, 8);
      await item(10, { at: hoursAfter(-5) });
      const oldestX = await item(11, { priority: 2, at: hoursAfter(-4) });
      const leadX = await item(12, { priority: 1, at: hoursAfter(-1) });

      expect(await feedIds(1, { limit: 1, random: () => 0.5 })).toEqual([leadX]);
      expect(await feedIds(1, { limit: 1, random: () => 0 })).toEqual([oldestX]);
    });
  });

  it('orders equal items per player, the same way every time', async () => {
    await players('Knight', 1, 6);
    for (let i = 0; i < 12; i++) {
      await image(100 + i);
      await item(100 + i, { at: hoursAfter(-i) });
    }
    const firsts: number[] = [];
    for (let p = 1; p <= 6; p++) {
      const once = await feedIds(p, { limit: 12 });
      expect(await feedIds(p, { limit: 12 })).toEqual(once);
      firsts.push(once?.[0] ?? 0);
    }
    expect(new Set(firsts).size).toBeGreaterThan(1);
  });
});
