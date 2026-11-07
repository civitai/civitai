import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { answerHiddenCheck } from '../hidden/hidden.service';
import {
  castVote,
  enqueueItem,
  ensureVotePartitions,
  getFeed,
  type QueueDeps,
} from './queue.service';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const deps: QueueDeps = { applyConsensus: async () => ({ outcome: 'applied' }), now: () => NOW };

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsVote","KnightsQueueItem","NewOrderPlayer","Image","Post" RESTART IDENTITY CASCADE`
  );
});

const enqueue = (imageId: number) =>
  enqueueItem(db, { questionKey: Q, imageId, source: 'test' }, NOW);
const vote = (userId: number, itemId: number) =>
  castVote(db, { userId, itemId, answer: '4' }, deps);
const reference = async (imageId: number) =>
  (
    await pg.query<{ id: number }>(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey") VALUES ($1,'hiddenCheck','4','harvested',$2) RETURNING id`,
      [imageId, Q]
    )
  ).rows[0].id;
const ledger = async (userId: number) => {
  const votes = await pg.query(`SELECT 1 FROM "KnightsVote" WHERE "playerId"=$1`, [userId]);
  const player = await pg.query<{ exp: number; goldPending: number }>(
    `SELECT exp, "goldPending" FROM "NewOrderPlayer" WHERE "userId"=$1`,
    [userId]
  );
  return { rows: votes.rows.length, ...player.rows[0] };
};

describe('one judgment per player per image and question', () => {
  it('refuses a second paid vote when the same image is queued again', async () => {
    await seedPlayer(pg, 1);
    await seedImage(pg, 10);
    const first = await enqueue(10);
    expect(await vote(1, first)).toMatchObject({ status: 'recorded' });
    const afterFirst = await ledger(1);

    await pg.query(`UPDATE "KnightsQueueItem" SET status='Closed' WHERE id=$1`, [first]);
    const requeued = await enqueue(10);
    expect(requeued).not.toBe(first);

    expect(await vote(1, requeued)).toEqual({ status: 'rejected', reason: 'already-voted' });
    expect(await ledger(1)).toEqual(afterFirst);
  });

  it('refuses a queue vote on an image the player already answered as a hidden check', async () => {
    await seedPlayer(pg, 1);
    await seedImage(pg, 10);
    const ref = await reference(10);
    expect(await answerHiddenCheck(db, { userId: 1, referenceId: ref, answer: '4' }, deps)).toEqual(
      { status: 'recorded' }
    );
    const afterCheck = await ledger(1);

    expect(await vote(1, await enqueue(10))).toEqual({
      status: 'rejected',
      reason: 'already-voted',
    });
    expect(await ledger(1)).toEqual(afterCheck);
  });

  it('refuses a hidden check on an image the player already voted in the queue', async () => {
    await seedPlayer(pg, 1);
    await seedImage(pg, 10);
    expect(await vote(1, await enqueue(10))).toMatchObject({ status: 'recorded' });
    const afterVote = await ledger(1);

    const ref = await reference(10);
    expect(await answerHiddenCheck(db, { userId: 1, referenceId: ref, answer: '4' }, deps)).toEqual(
      { status: 'rejected', reason: 'already-voted' }
    );
    expect(await ledger(1)).toEqual(afterVote);
  });

  it('lets another player judge the same image, and the same player judge another image', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await seedImage(pg, 10);
    await seedImage(pg, 11);
    expect(await vote(1, await enqueue(10))).toMatchObject({ status: 'recorded' });
    expect(await vote(2, 1)).toMatchObject({ status: 'recorded' });
    expect(await vote(1, await enqueue(11))).toMatchObject({ status: 'recorded' });
  });

  it('does not serve a re-queued image the player already judged, and serves the next one', async () => {
    await seedPlayer(pg, 1);
    await seedImage(pg, 10);
    await seedImage(pg, 11);
    const first = await enqueue(10);
    expect(await vote(1, first)).toMatchObject({ status: 'recorded' });
    await pg.query(`UPDATE "KnightsQueueItem" SET status='Closed' WHERE id=$1`, [first]);
    const requeued = await enqueue(10);
    const other = await enqueue(11);

    const feed = await getFeed(db, 1);
    expect(feed?.items.map((i) => i.id)).toEqual([other]);
    expect(feed?.items.map((i) => i.id)).not.toContain(requeued);
  });
});
