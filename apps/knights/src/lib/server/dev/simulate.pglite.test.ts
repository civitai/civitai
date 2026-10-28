import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { PROGRESSION } from '../progression/config';
import {
  castVote,
  enqueueItem,
  ensureVotePartitions,
  type QueueDeps,
} from '../queue/queue.service';
import { listSimulatableItems, simulateOtherVoters } from './simulate';

const NOW = new Date('2026-12-15T12:00:00Z');
let pg: PGlite;
let db: Kysely<DB>;
const applyConsensus = vi.fn<QueueDeps['applyConsensus']>(async () => ({ outcome: 'applied' }));
const deps: QueueDeps = { applyConsensus, now: () => NOW };

async function seed(players: number) {
  for (let i = 1; i <= players; i++) {
    await pg.query(`INSERT INTO "NewOrderPlayer" ("userId","rankType") VALUES ($1,'Knight')`, [i]);
  }
  await pg.exec(`INSERT INTO "Post" ("id","publishedAt") VALUES (10,'2020-01-01')`);
  await pg.exec(`INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES (10,'key-10',4,10)`);
  return enqueueItem(
    db,
    { questionKey: 'knights.image.nsfwLevel', imageId: 10, source: 'test', expiresAt: null },
    NOW
  );
}

const player = async (id: number) =>
  (
    await pg.query<{ exp: number; goldEarned: number; goldPending: number }>(
      `SELECT exp, "goldEarned", "goldPending" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [id]
    )
  ).rows[0];

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

describe('simulateOtherVoters', () => {
  it('resolves a solo tester item and pays the tester through the normal path', async () => {
    const id = await seed(8);
    await castVote(db, { userId: 1, itemId: id, answer: '4' }, deps);

    const result = await simulateOtherVoters(db, { callerId: 1, itemId: id, answer: '4' }, deps);

    expect(result).toEqual({ cast: 4, itemStatus: 'Resolved', settled: true });
    expect(await player(1)).toMatchObject({
      exp: PROGRESSION.voteXp + PROGRESSION.correctXp,
      goldEarned: PROGRESSION.baseGold,
      goldPending: 0,
    });
  });

  it('never votes as the caller, and makes a wrong tester lose', async () => {
    const id = await seed(8);
    await castVote(db, { userId: 1, itemId: id, answer: '8' }, deps);

    await simulateOtherVoters(db, { callerId: 1, itemId: id, answer: '4' }, deps);

    expect(await player(1)).toMatchObject({ goldEarned: 0, goldPending: 0 });
    const own = await pg.query(`SELECT 1 FROM "KnightsVote" WHERE "playerId"=1`);
    expect(own.rows).toHaveLength(1);
  });

  it('stops when no other eligible player is left', async () => {
    const id = await seed(3);
    await castVote(db, { userId: 1, itemId: id, answer: '4' }, deps);

    expect(await simulateOtherVoters(db, { callerId: 1, itemId: id, answer: '4' }, deps)).toEqual({
      cast: 2,
      itemStatus: 'Open',
      settled: false,
    });
  });

  it('lists open items with the ones the caller judged first', async () => {
    const id = await seed(2);
    await pg.exec(`INSERT INTO "Post" ("id","publishedAt") VALUES (11,'2020-01-01')`);
    await pg.exec(
      `INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES (11,'key-11',4,11)`
    );
    const other = await enqueueItem(
      db,
      { questionKey: 'knights.image.nsfwLevel', imageId: 11, source: 'test', expiresAt: null },
      NOW
    );
    await castVote(db, { userId: 1, itemId: other, answer: '4' }, deps);

    const items = await listSimulatableItems(db, 1);
    expect(items.map((i) => [i.id, i.votedByMe, i.votes])).toEqual([
      [other, true, 1],
      [id, false, 0],
    ]);
  });
});
