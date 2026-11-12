import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';

// What a caller sees when a dependency of the notifications app fails or hangs. Drives the real routes,
// operations, cache and lag tracker through `app.inject`; only the pg pools, the redis client and Axiom are
// faked, each switchable between answering, rejecting and never settling.
//
//   - create: a DB failure must reach the producer as a 5xx so its client retries. The write is an upsert by
//     key, so a retry cannot double-queue.
//   - count: a failing or hung redis is a cache/lag-flag outage, not a count outage — answer from the DB.
//   - any authed route: a hung DB answers 503 at the handler deadline instead of holding the caller.

type Mode = 'ok' | 'reject' | 'hang';

const h = vi.hoisted(() => {
  // Read at module load by env.ts / lag.ts, so set before the app is imported.
  process.env.REPLICATION_LAG_DELAY = '10';
  process.env.NOTIFICATIONS_HANDLER_DEADLINE_MS = '1000';
  process.env.NOTIFICATIONS_COUNT_REDIS_DEADLINE_MS = '200';
  delete process.env.NOTIFICATIONS_TOKEN;
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

  it('answers 503 within the handler deadline when the DB never answers', async () => {
    h.state.db = 'hang';
    const started = Date.now();
    const res = await within(3000, { method: 'POST', url: '/notifications', payload: createBody });
    expect(res).not.toBe('hung');
    if (res === 'hung') return;
    expect(res.statusCode).toBe(503);
    // The deadline is 1000 ms in this file; the margin is for a loaded box, not for a missing deadline.
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe('POST /notifications/count when redis fails', () => {
  it('answers from the DB when every redis call rejects', async () => {
    h.state.redis = 'reject';
    const res = await within(2000, {
      method: 'POST',
      url: '/notifications/count',
      payload: countBody(),
    });
    expect(res).not.toBe('hung');
    if (res === 'hung') return;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ category: 'Comment', count: '3' }]);
    expect(h.state.dbCalls).toBe(1);
  });

  it('answers from the DB well inside 2 s when every redis call hangs', async () => {
    h.state.redis = 'hang';
    const started = Date.now();
    const res = await within(2000, {
      method: 'POST',
      url: '/notifications/count',
      payload: countBody(),
    });
    expect(res).not.toBe('hung');
    if (res === 'hung') return;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ category: 'Comment', count: '3' }]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.each(['reject', 'hang'] as const)(
    'answers from the DB when the lag flag reads but the count cache calls %s',
    async (mode) => {
      h.state.cache = mode;
      const res = await within(2000, {
        method: 'POST',
        url: '/notifications/count',
        payload: countBody(),
      });
      expect(res).not.toBe('hung');
      if (res === 'hung') return;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([{ category: 'Comment', count: '3' }]);
      expect(h.state.dbCalls).toBe(1);
    }
  );

  it('answers 503 within the handler deadline when the DB hangs too', async () => {
    h.state.redis = 'hang';
    h.state.db = 'hang';
    const res = await within(3000, {
      method: 'POST',
      url: '/notifications/count',
      payload: countBody(),
    });
    expect(res).not.toBe('hung');
    if (res === 'hung') return;
    expect(res.statusCode).toBe(503);
  });
});
