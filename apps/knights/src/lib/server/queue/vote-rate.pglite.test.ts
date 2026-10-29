import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedPlayer } from '../../../test/seed';
import { castVote, enqueueItem, ensureVotePartitions, type QueueDeps } from './queue.service';
import { voteLockUntil, type VoteLimit } from './vote-rate';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const LIMITS: VoteLimit[] = [{ windowSeconds: 60, max: 3 }];
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

let pg: PGlite;
let db: Kysely<DB>;
const applyConsensus = vi.fn<QueueDeps['applyConsensus']>(async () => ({ outcome: 'applied' }));
const depsAt = (now: Date, voteLimits: VoteLimit[] | undefined = LIMITS): QueueDeps => ({
  applyConsensus,
  now: () => now,
  voteLimits,
});

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY`
  );
  await seedPlayer(pg, 1);
});

let nextImage = 100;
async function freshItem() {
  const id = nextImage++;
  await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,'2020-01-01')`, [id]);
  await pg.query(`INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES ($1,$2,4,$1)`, [
    id,
    `key-${id}`,
  ]);
  return enqueueItem(db, { questionKey: Q, imageId: id, source: 'test', minRank: 'Knight' }, NOW);
}

async function vote(now: Date, extra: { isModerator?: boolean } = {}, limits?: VoteLimit[]) {
  const itemId = await freshItem();
  return castVote(db, { userId: 1, itemId, answer: '4', ...extra }, depsAt(now, limits));
}

describe('vote pacing', () => {
  it('counts votes up to the limit and then locks the player out until the oldest one ages out', async () => {
    for (let i = 0; i < 3; i++) expect((await vote(at(i))).status).toBe('recorded');

    const limited = await vote(at(10));

    expect(limited).toEqual({ status: 'limited', until: at(60) });
    expect(await voteLockUntil(db, 1, at(10), LIMITS)).toEqual(at(60));
  });

  it('does not record the refused vote', async () => {
    for (let i = 0; i < 3; i++) await vote(at(i));
    await vote(at(10));

    const { rows } = await pg.query(`SELECT 1 FROM "KnightsVote" WHERE "playerId" = 1`);
    expect(rows).toHaveLength(3);
  });

  it('lets the player vote again once the window has passed', async () => {
    for (let i = 0; i < 3; i++) await vote(at(i));

    expect((await vote(at(60))).status).toBe('recorded');
  });

  it('applies the tightest of several windows', async () => {
    const limits: VoteLimit[] = [
      { windowSeconds: 60, max: 100 },
      { windowSeconds: 3600, max: 2 },
    ];
    await vote(at(0), {}, limits);
    await vote(at(30), {}, limits);

    expect(await voteLockUntil(db, 1, at(31), limits)).toEqual(at(3600));
  });

  it('does not limit a moderator', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await vote(at(i), { isModerator: true })).status).toBe('recorded');
    }
  });

  it('does not limit anyone when no limits are configured', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await vote(at(i), {}, [])).status).toBe('recorded');
    }
  });

  it("does not count another player's votes", async () => {
    await seedPlayer(pg, 2);
    for (let i = 0; i < 3; i++) await vote(at(i));

    expect(await voteLockUntil(db, 2, at(5), LIMITS)).toBeNull();
  });
});
