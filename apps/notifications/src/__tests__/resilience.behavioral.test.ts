import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';

// What a caller sees when a dependency of the notifications app fails or hangs. Drives the real routes,
// operations, cache and lag tracker through `app.inject`; only the pg pools, the redis client and Axiom are
// faked, each switchable between answering, rejecting and never settling.
//
//   - create: a DB failure must reach the producer as a 5xx so its client retries. The write is an upsert by
//     key, so a retry cannot double-queue.
//   - count: every redis call is bounded. A failed or timed-out one answers an empty count at once, without
//     a DB read, unless NOTIFICATIONS_COUNT_DB_FALLBACK=true, which answers from the DB instead. Either way
//     the failure is counted where an operator looks for redis trouble.

type Mode = 'ok' | 'reject' | 'hang';

const h = vi.hoisted(() => {
  // Read at module load by env.ts / lag.ts, so set before the app is imported.
  process.env.REPLICATION_LAG_DELAY = '10';
  process.env.NOTIFICATIONS_COUNT_REDIS_DEADLINE_MS = '200';
  delete process.env.NOTIFICATIONS_TOKEN;
  delete process.env.NOTIFICATIONS_COUNT_DB_FALLBACK;
  // `redis` drives every call; `cache`, when set, overrides it for the count-cache hash calls only, so
  // the lag-flag read can answer while the cache misbehaves.
  const state = { db: 'ok' as Mode, redis: 'ok' as Mode, cache: null as Mode | null, dbCalls: 0 };
  const never = () => new Promise<never>(() => undefined);
  const settle = <T>(mode: Mode, value: T): Promise<T> =>
    mode === 'hang'
      ? never()
      : mode === 'reject'
      ? Promise.reject(new Error(`fake ${mode}`))
      : Promise.resolve(value);

  // Two distinct objects: the count path tells the primary from the replica by identity.
  const makePool = () => ({
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    cancellableQuery: (sql: string) => {
      state.dbCalls++;
      const rows = sql.includes('COUNT(*)') ? [{ category: 'Comment', count: '3' }] : [];
      if (state.db === 'hang') return never();
      if (state.db === 'reject') return Promise.reject(new Error('connection terminated'));
      return Promise.resolve({ result: async () => rows });
    },
  });
  const writePool = makePool();
  const readPool = makePool();
  const redis = {
    get: () => settle(state.redis, null),
    set: () => settle(state.redis, 'OK'),
    hGetAll: () => settle(state.cache ?? state.redis, {}),
    hSetMultiWithExpire: () => settle(state.cache ?? state.redis, 1),
    del: () => settle(state.cache ?? state.redis, 1),
    exists: () => settle(state.cache ?? state.redis, 0),
    expire: () => settle(state.cache ?? state.redis, 1),
  };
  return { state, writePool, readPool, redis };
});

vi.mock('../lib/server/clients/db', () => ({
  notifDbWrite: () => h.writePool,
  notifDbRead: () => h.readPool,
  mainDbRead: () => h.readPool,
  mainDbWrite: () => h.writePool,
}));
vi.mock('../lib/server/clients/redis', () => ({ getRedis: () => h.redis }));
vi.mock('../lib/server/clients/axiom', () => ({ logToAxiom: vi.fn(async () => undefined) }));

import { buildServer } from '../app';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  h.state.db = 'ok';
  h.state.redis = 'ok';
  h.state.cache = null;
  h.state.dbCalls = 0;
  delete process.env.NOTIFICATIONS_COUNT_DB_FALLBACK;
});

/** The inject result, or the string 'hung' when the app has not answered within `ms`. */
async function within(ms: number, req: InjectOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), ms)));
  try {
    return await Promise.race([app.inject(req), hung]);
  } finally {
    clearTimeout(timer);
  }
}

const createBody = {
  key: 'comment:1',
  type: 'comment',
  category: 'Comment',
  details: {},
  userId: 7,
};
// A fresh user per call: the count route coalesces concurrent calls per user, so a count an earlier case
// left hung would otherwise be joined by the next case.
let nextUserId = 100;
const countBody = () => ({ userId: nextUserId++, unread: true });

async function count() {
  const started = Date.now();
  const res = await within(2000, {
    method: 'POST',
    url: '/notifications/count',
    payload: countBody(),
  });
  return { res, ms: Date.now() - started };
}

/** Current value of notifications_redis_errors_total for one operation, read off the scrape. */
async function redisErrors(operation: string): Promise<number> {
  const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
  const line = body
    .split('\n')
    .find((l) => l.startsWith(`notifications_redis_errors_total{operation="${operation}"}`));
  return line ? Number(line.split(' ').pop()) : 0;
}

describe('POST /notifications when the DB fails', () => {
  it('answers 503 so the producer retries, never a 202 for a row that was not queued', async () => {
    h.state.db = 'reject';
    const res = await within(2000, { method: 'POST', url: '/notifications', payload: createBody });
    expect(res).not.toBe('hung');
    if (res === 'hung') return;
    expect(res.statusCode).toBe(503);
  });

  it('still answers 202 when the DB is healthy (control)', async () => {
    const res = await app.inject({ method: 'POST', url: '/notifications', payload: createBody });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'queued', queued: 1 });
  });
});

const failures = [
  ['every redis call rejects', () => (h.state.redis = 'reject')],
  ['every redis call hangs', () => (h.state.redis = 'hang')],
  ['the lag flag reads but the count cache rejects', () => (h.state.cache = 'reject')],
  ['the lag flag reads but the count cache hangs', () => (h.state.cache = 'hang')],
] as const;

describe('POST /notifications/count when redis fails, DB fallback off (the default)', () => {
  it.each(failures)('answers an empty count fast, without a DB read, when %s', async (_n, fail) => {
    fail();
    const { res, ms } = await count();
    expect(res).not.toBe('hung');
    if (res === 'hung') return;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(h.state.dbCalls).toBe(0);
    // Bounded by the 200 ms per-call deadline in this file; the margin is for a loaded box.
    expect(ms).toBeLessThan(1000);
  });

  it('reads the DB when redis is healthy (control)', async () => {
    const { res } = await count();
    expect(res).not.toBe('hung');
    if (res === 'hung') return;
    expect(res.json()).toEqual([{ category: 'Comment', count: '3' }]);
    expect(h.state.dbCalls).toBe(1);
  });
});

describe('POST /notifications/count when redis fails, DB fallback on', () => {
  it.each(failures)('answers from the DB when %s', async (_n, fail) => {
    process.env.NOTIFICATIONS_COUNT_DB_FALLBACK = 'true';
    fail();
    const { res, ms } = await count();
    expect(res).not.toBe('hung');
    if (res === 'hung') return;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ category: 'Comment', count: '3' }]);
    expect(h.state.dbCalls).toBe(1);
    expect(ms).toBeLessThan(2000);
  });
});

describe('a count-path redis failure is counted like the worker counts one', () => {
  it('a hung lag-flag read increments notifications_redis_errors_total{operation="lag"}', async () => {
    const before = await redisErrors('lag');
    h.state.redis = 'hang';
    await count();
    expect(await redisErrors('lag')).toBe(before + 1);
  });

  it('a rejected lag-flag read increments it too', async () => {
    const before = await redisErrors('lag');
    h.state.redis = 'reject';
    await count();
    expect(await redisErrors('lag')).toBe(before + 1);
  });

  it('a hung cache read increments notifications_redis_errors_total{operation="get"}', async () => {
    const before = await redisErrors('get');
    h.state.cache = 'hang';
    await count();
    expect(await redisErrors('get')).toBe(before + 1);
  });
});
