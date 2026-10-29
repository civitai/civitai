import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { getDailyStatus } from '../daily/daily.service';
import { getPlayerStatus } from '../player-status';
import { listJudgments } from '../progression/judgments';
import { ledgerOf } from '../progression/progression';
import { castVote, enqueueItem, ensureVotePartitions } from '../queue/queue.service';
import { answerHiddenCheck } from './hidden.service';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const limits = [{ windowSeconds: 60, max: 1 }];

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsVote","KnightsQueueItem","KnightsPlayerDay","KnightsPlayer","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
  );
});

/** Player 1 votes a queue item, player 2 answers a hidden check; both stay pending. */
async function setup() {
  await seedPlayer(pg, 1);
  await seedPlayer(pg, 2);
  await seedImage(pg, 10);
  await seedImage(pg, 11);
  const itemId = await enqueueItem(
    db,
    { questionKey: Q, imageId: 10, source: 'test', expiresAt: null },
    NOW
  );
  const ref = (
    await pg.query<{ id: number }>(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey") VALUES (11,'hiddenCheck','4','harvested',$1) RETURNING id`,
      [Q]
    )
  ).rows[0].id;
  const deps = {
    applyConsensus: async () => ({ outcome: 'applied' as const }),
    now: () => NOW,
    voteLimits: limits,
  };
  return { itemId, ref, deps };
}

describe('a hidden check and a queue vote', () => {
  it('answer, pay and show the same until the check is graded', async () => {
    const { itemId, ref, deps } = await setup();
    expect(await castVote(db, { userId: 1, itemId, answer: '8' }, deps)).toEqual({
      status: 'recorded',
    });
    expect(await answerHiddenCheck(db, { userId: 2, referenceId: ref, answer: '8' }, deps)).toEqual(
      {
        status: 'recorded',
      }
    );

    expect(await getPlayerStatus(db, 2)).toEqual(await getPlayerStatus(db, 1));
    expect(await getDailyStatus(db, { playerId: 2, rank: 'Knight', now: NOW })).toEqual(
      await getDailyStatus(db, { playerId: 1, rank: 'Knight', now: NOW })
    );
    expect(await ledgerOf(db, 2)).toEqual(await ledgerOf(db, 1));

    const shown = async (id: number) =>
      (await listJudgments(db, id, { page: 1 })).judgments.map(
        ({ status, xp, gold, prompt, answerLabel, at }) => ({
          status,
          xp,
          gold,
          prompt,
          answerLabel,
          at,
        })
      );
    expect(await shown(2)).toEqual(await shown(1));
    expect(await shown(2)).toHaveLength(1);

    const row = async (id: number) =>
      (
        await pg.query(
          `SELECT "questionKey", stage, answer, weight, verdict, xp, gold, "settledAt" FROM "KnightsVote" WHERE "playerId"=$1`,
          [id]
        )
      ).rows;
    expect(await row(2)).toEqual(await row(1));
  });

  it('are paced alike', async () => {
    const { itemId, ref, deps } = await setup();
    await castVote(db, { userId: 1, itemId, answer: '8' }, deps);
    await answerHiddenCheck(db, { userId: 2, referenceId: ref, answer: '8' }, deps);
    await seedImage(pg, 12);
    const second = await enqueueItem(
      db,
      { questionKey: Q, imageId: 12, source: 'test', expiresAt: null },
      NOW
    );
    const ref2 = (
      await pg.query<{ id: number }>(
        `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey") VALUES (12,'hiddenCheck','4','harvested',$1) RETURNING id`,
        [Q]
      )
    ).rows[0].id;
    const queued = await castVote(db, { userId: 1, itemId: second, answer: '8' }, deps);
    const checked = await answerHiddenCheck(
      db,
      { userId: 2, referenceId: ref2, answer: '8' },
      deps
    );
    expect(checked).toEqual(queued);
    expect(queued).toMatchObject({ status: 'limited' });
  });
});
