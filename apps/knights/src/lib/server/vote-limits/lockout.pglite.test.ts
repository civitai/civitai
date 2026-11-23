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
import { createVoteGate, type GateClient, type Pause } from './gate';
import { voteLockout, votePause } from './lockout';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const LIMITS: VoteLimit[] = [{ windowSeconds: 60, max: 2 }];
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

let pg: PGlite;
let db: Kysely<DB>;
const deps = (voteLimits: VoteLimit[], now = NOW): QueueDeps => ({
  applyConsensus: async () => ({ outcome: 'applied' }),
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
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
  );
  await seedPlayer(pg, 1);
});

let nextImage = 100;
async function vote(limits: VoteLimit[], gate?: ReturnType<typeof createVoteGate>, now = NOW) {
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
  const cast = () => castVote(db, { userId: 1, itemId, answer: '4' }, deps(limits, now));
  return gate ? gate.guard(1, now, cast) : cast();
}

const gateWith = (cooldown: Date | null, windowSeconds: number | null = null) => ({
  cooldown: async () => (cooldown ? { until: cooldown, windowSeconds } : null),
  freeze: async (_userId: number, _now: Date, pause: Pause) => pause,
});
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

  it('names the window behind the pause: the ledger window, or the cooldown when it ends later', async () => {
    await vote(LIMITS);
    await vote(LIMITS);
    expect(await votePause(db, 1, NOW, { gate: gateWith(null), limits: limits(LIMITS) })).toEqual({
      until: at(60),
      windowSeconds: 60,
    });
    expect(
      await votePause(db, 1, NOW, { gate: gateWith(at(600), 86400), limits: limits(LIMITS) })
    ).toEqual({ until: at(600), windowSeconds: 86400 });
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

// The countdown never moves later during a pause, however many refused votes arrive.
describe('a pause the player is shown', () => {
  const HOUR: VoteLimit[] = [{ windowSeconds: 3600, max: 3 }];
  const HOUR_COUNTER = 'knights:vote-limit:{1}:w3600';
  const ledgerRows = async () =>
    (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "KnightsVote"`)).rows[0].n;

  function redisGate() {
    const redis = fakeRedis();
    redis.clock.now = NOW.getTime();
    const gate = createVoteGate({
      client: () => redis.client,
      limits: async () => HOUR,
      timeoutMs: 2000,
    });
    return {
      redis,
      gate,
      shown: (now = NOW) => voteLockout(db, 1, now, { gate, limits: limits(HOUR) }),
    };
  }

  it('labels a pause the ledger set, so refusals during it name the limit', async () => {
    const { gate } = redisGate();
    for (let i = 0; i < 3; i++) await vote(HOUR, gate);
    expect(await votePause(db, 1, NOW, { gate, limits: limits(HOUR) })).toMatchObject({
      windowSeconds: 3600,
    });
    expect(await gate.guard(1, NOW, async () => 'ok')).toMatchObject({
      status: 'limited',
      windowSeconds: 3600,
    });
  });

  it('never ends later while refused votes keep arriving', async () => {
    const { redis, gate, shown } = redisGate();
    // Three votes 38 minutes ago, in a fixed Redis hour that has since rolled over: the ledger's
    // trailing hour is full, the Redis hour counter is empty.
    for (let i = 0; i < 3; i++) await vote(HOUR, undefined, at(-38 * 60));
    expect(await shown()).toEqual(at(22 * 60));

    for (let i = 0; i < 6; i++) {
      expect(await vote(HOUR, gate)).toMatchObject({ status: 'limited' });
      expect(await shown()).toEqual(at(22 * 60));
    }
    // No vote is recorded during the pause, and the refused ones are not counted against the next hour.
    expect(await ledgerRows()).toBe(3);
    expect(redis.get(HOUR_COUNTER)).toBeUndefined();
  });

  it('keeps one end for concurrent refused votes and records none of them', async () => {
    const { redis, gate, shown } = redisGate();
    for (let i = 0; i < 3; i++) await vote(HOUR, undefined, at(-38 * 60));
    const first = (await shown())!;
    expect(first).toEqual(at(22 * 60));

    // What the vote action answers a pace refusal: the shown end, with the refusal's as a floor.
    const attempt = async () => {
      const out = await vote(HOUR, gate);
      if (out.status !== 'limited' || ('busy' in out && out.busy)) return null;
      return voteLockout(db, 1, NOW, { gate, limits: limits(HOUR) }, out.until);
    };
    const ends = await Promise.all(Array.from({ length: 9 }, attempt));
    for (const end of ends) if (end) expect(end.getTime()).toBeLessThanOrEqual(first.getTime());
    expect(await shown()).toEqual(first);
    expect(await ledgerRows()).toBe(3);

    redis.clock.now = first.getTime();
    expect(await shown(first)).toBeNull();
    expect(await vote(HOUR, gate, first)).toMatchObject({ status: 'recorded' });
  });

  it('ends at the time it showed, and voting resumes', async () => {
    const { redis, gate, shown } = redisGate();
    for (let i = 0; i < 3; i++) await vote(HOUR, undefined, at(-38 * 60));
    expect(await shown()).toEqual(at(22 * 60));
    expect(await vote(HOUR, gate)).toMatchObject({ status: 'limited', until: at(22 * 60) });

    redis.clock.now = at(22 * 60).getTime();
    expect(await shown(at(22 * 60))).toBeNull();
    expect(await vote(HOUR, gate, at(22 * 60))).toMatchObject({ status: 'recorded' });
  });

  // The sliding limit as configured: when a pause ends the window holds max - 1 votes, so the next
  // vote fills it and a new, shorter pause runs until the next-oldest vote leaves.
  it('starts a new, shorter pause after the next vote at the cap', async () => {
    const { redis, gate, shown } = redisGate();
    await vote(HOUR, undefined, at(-50 * 60));
    await vote(HOUR, undefined, at(-40 * 60));
    await vote(HOUR, undefined, at(-30 * 60));
    expect(await shown()).toEqual(at(10 * 60));

    redis.clock.now = at(10 * 60).getTime();
    expect(await vote(HOUR, gate, at(10 * 60))).toMatchObject({ status: 'recorded' });
    expect(await shown(at(10 * 60))).toEqual(at(20 * 60));
  });

  it('shows the ledger end when Redis is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down: GateClient = new Proxy({} as GateClient, {
      get: () => async () => Promise.reject(new Error('down')),
    });
    const gate = createVoteGate({ client: () => down, limits: async () => HOUR, timeoutMs: 50 });
    for (let i = 0; i < 3; i++) await vote(HOUR, undefined, at(-38 * 60));

    expect(await voteLockout(db, 1, NOW, { gate, limits: limits(HOUR) })).toEqual(at(22 * 60));
    expect(await vote(HOUR, gate)).toEqual({ status: 'limited', until: at(22 * 60) });
  });
});
