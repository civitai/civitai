import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedPlayer } from '../../../test/seed';
import {
  castVote,
  enqueueItem,
  ensureVotePartitions,
  type QueueDeps,
} from '../queue/queue.service';
import type { VoteLimit } from '../queue/vote-rate';
import { fakeRedis } from './fake-redis';
import { createVoteGate, type GateClient } from './gate';
import { voteLockout } from './lockout';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const LIMITS: VoteLimit[] = [{ windowSeconds: 60, max: 2 }];
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

let pg: PGlite;
let db: Kysely<DB>;
const deps = (voteLimits: VoteLimit[]): QueueDeps => ({
  applyConsensus: async () => ({ outcome: 'applied' }),
  now: () => NOW,
  voteLimits,
});

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
  );
  await seedPlayer(pg, 1);
});

let nextImage = 100;
async function vote(limits: VoteLimit[], gate?: ReturnType<typeof createVoteGate>) {
  const id = nextImage++;
  await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,'2020-01-01')`, [id]);
  await pg.query(`INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES ($1,$2,4,$1)`, [
    id,
    `key-${id}`,
  ]);
  const itemId = await enqueueItem(
    db,
    { questionKey: Q, imageId: id, source: 'test', minRank: 'Knight' },
    NOW
  );
  const cast = () => castVote(db, { userId: 1, itemId, answer: '4' }, deps(limits));
  return gate ? gate.guard(1, NOW, cast) : cast();
}

const gateWith = (cooldown: Date | null) => ({ cooldownUntil: async () => cooldown });
const limits = (live: VoteLimit[]) => ({ load: async () => live });

describe('voteLockout', () => {
  it('is the Redis cooldown when the ledger holds nothing back', async () => {
    expect(
      await voteLockout(db, 1, NOW, { gate: gateWith(at(600)), limits: limits(LIMITS) })
    ).toEqual(at(600));
  });

  it('is the ledger lock when there is no cooldown', async () => {
    await vote(LIMITS);
    await vote(LIMITS);
    expect(await voteLockout(db, 1, NOW, { gate: gateWith(null), limits: limits(LIMITS) })).toEqual(
      at(60)
    );
  });

  it('is the later of the two', async () => {
    await vote(LIMITS);
    await vote(LIMITS);
    expect(
      await voteLockout(db, 1, NOW, { gate: gateWith(at(600)), limits: limits(LIMITS) })
    ).toEqual(at(600));
    expect(
      await voteLockout(db, 1, NOW, { gate: gateWith(at(5)), limits: limits(LIMITS) })
    ).toEqual(at(60));
  });

  it('is null for a player nothing holds back, and follows the live limits', async () => {
    await vote(LIMITS);
    expect(
      await voteLockout(db, 1, NOW, { gate: gateWith(null), limits: limits(LIMITS) })
    ).toBeNull();
    expect(
      await voteLockout(db, 1, NOW, {
        gate: gateWith(null),
        limits: limits([{ windowSeconds: 60, max: 1 }]),
      })
    ).toEqual(at(60));
  });
});

describe('the ledger limit behind the Redis gate', () => {
  it('still limits when Redis is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down: GateClient = new Proxy({} as GateClient, {
      get: () => async () => Promise.reject(new Error('down')),
    });
    const gate = createVoteGate({ client: () => down, limits: async () => LIMITS, timeoutMs: 50 });

    expect((await vote(LIMITS, gate)).status).toBe('recorded');
    expect((await vote(LIMITS, gate)).status).toBe('recorded');
    expect(await vote(LIMITS, gate)).toEqual({ status: 'limited', until: at(60) });
  });

  it('is not reached by a vote the gate already refused', async () => {
    const redis = fakeRedis();
    const gate = createVoteGate({
      client: () => redis.client,
      limits: async () => LIMITS,
      timeoutMs: 50,
    });
    await vote(LIMITS, gate);
    await vote(LIMITS, gate);
    const refused = await vote(LIMITS, gate);

    expect(refused).toMatchObject({ status: 'limited' });
    expect((await pg.query(`SELECT count(*)::int AS n FROM "KnightsVote"`)).rows[0]).toEqual({
      n: 2,
    });
  });
});
