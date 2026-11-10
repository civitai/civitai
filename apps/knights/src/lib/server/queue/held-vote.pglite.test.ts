import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { createQueueDb } from '../../../test/pglite-kysely';
import { castVote, enqueueItem, ensureVotePartitions } from './queue.service';

// No reachable standing weighs 0 for a player who may vote (rank base weights are positive and the smite
// limit resets the career first), so the weightless case is forced.
vi.mock('./resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resolution')>()),
  voteWeight: () => 0,
}));

const NOW = new Date('2026-12-15T12:00:00Z');
let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","Image","Post" RESTART IDENTITY CASCADE`
  );
  await pg.exec(
    `INSERT INTO "NewOrderPlayer" ("userId","rankType") VALUES (1,'Knight'),(2,'Knight')`
  );
  await pg.exec(`INSERT INTO "Post" ("id","publishedAt") VALUES (10,'2020-01-01')`);
  await pg.exec(`INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES (10,'key-10',4,10)`);
});

const cast = async (userId: number) => {
  const itemId = await enqueueItem(
    db,
    {
      questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
      imageId: 10,
      source: 'test',
      minRank: 'Knight',
      expiresAt: null,
    },
    NOW
  );
  return castVote(
    db,
    { userId, itemId, answer: '4' },
    { applyConsensus: vi.fn(async () => ({ outcome: 'applied' as const })), now: () => NOW }
  );
};

describe('a vote that weighs nothing', () => {
  it('is refused as no-weight for a player who is not held', async () => {
    expect(await cast(1)).toMatchObject({ status: 'rejected', reason: 'no-weight' });
    expect((await pg.query(`SELECT 1 FROM "KnightsVote"`)).rows).toEqual([]);
  });

  it('is refused as no-weight for a held player too, since only a positive weight is replaced by 0', async () => {
    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt" = now() WHERE "userId" = 2`);
    expect(await cast(2)).toMatchObject({ status: 'rejected', reason: 'no-weight' });
    expect((await pg.query(`SELECT 1 FROM "KnightsVote"`)).rows).toEqual([]);
  });
});
