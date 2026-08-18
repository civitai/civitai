import { describe, it, expect, vi, beforeEach } from 'vitest';

// ROUTE-LEVEL SEAM TEST.
//
// health.runHealthChecks.test.ts proves runHealthChecks itself treats the DB write
// checks as soft for 'readiness' and hard for 'startup'. That proves NOTHING about
// which mode each ROUTE asks for — the two surfaces are tested separately, and the
// defect that matters lives in the seam: /api/ready dropping its `{ mode: 'startup' }`
// argument, or /api/health acquiring one, would leave every unit test green while
// either failing closed across the whole fleet or letting a never-connected pod into
// the pool.
//
// So this file exercises the HANDLERS and asserts the relationship between them:
// with an identical broken write primary, /api/health must answer 200 healthy and
// /api/ready must answer 503 not-ready. Nothing but correct wiring on BOTH sides
// satisfies both halves at once.
//
// Same module-mock set as the unit file (health.ts pulls a large dependency graph),
// plus the warmup module, since /api/ready is warm-gated ahead of its dep checks.

const mocks = vi.hoisted(() => ({
  sysRedis: {
    isReady: true,
    ping: vi.fn(async () => 'PONG'),
    hGet: vi.fn(async () => '[]'),
  },
  redis: { isReady: true },
  dbRead: { $transaction: vi.fn(async () => 1) },
  dbWrite: { $transaction: vi.fn(async () => 1) },
  pgDbRead: { query: vi.fn(async () => ({})) },
  pgDbWrite: { query: vi.fn(async () => ({})) },
}));

vi.mock('~/env/other', () => ({ isProd: false, isDev: false, isTest: true }));
vi.mock('~/env/server', () => ({
  env: { HEALTHCHECK_TIMEOUT: 1000, HEALTHCHECK_DISABLED: [] as string[] },
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/db/client', () => ({ dbRead: mocks.dbRead, dbWrite: mocks.dbWrite }));
vi.mock('~/server/db/pgDb', () => ({
  pgDbReadLong: {},
  pgDbRead: mocks.pgDbRead,
  pgDbWrite: mocks.pgDbWrite,
}));
vi.mock('~/server/meilisearch/client', () => ({
  metricsSearchClient: null,
  withMeiliHealthProbe: (fn: () => Promise<boolean>) => fn(),
  MeiliCallTimeoutError: class MeiliCallTimeoutError extends Error {},
}));
vi.mock('~/server/prom/client', () => ({
  registerCounter: () => ({ inc: vi.fn() }),
  registerCounterWithLabels: () => ({ inc: vi.fn() }),
  registerHistogram: () => ({ observe: vi.fn() }),
}));
vi.mock('~/server/redis/client', () => ({
  redis: mocks.redis,
  sysRedis: mocks.sysRedis,
  REDIS_SYS_KEYS: {
    SYSTEM: {
      DISABLED_HEALTHCHECKS: 'sys:disabled-healthchecks',
      NON_CRITICAL_HEALTHCHECKS: 'sys:non-critical-healthchecks',
      FEATURES: 'sys:features',
    },
  },
}));
// WebhookEndpoint is the `?token` gate; unwrap it so the handler is callable.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/utils/number-helpers', () => ({ getRandomInt: () => 123 }));
// /api/ready gates on warmth BEFORE it runs any dependency check. Report warm so
// the dep checks actually execute — an unwarm pod 503s for an unrelated reason and
// would make every assertion below vacuous.
vi.mock('~/server/warmup', () => ({
  isWarm: () => true,
  getWarmState: () => 'warmed-ok',
  getWarmDurationMs: () => 42,
  didFailOpenTimeout: () => false,
}));

import healthHandler from '~/pages/api/health';
import readyHandler from '~/pages/api/ready';

type Captured = { status: number; body: Record<string, unknown> };

// Minimal NextApiResponse stand-in: records status+json and supports the
// res.on('close') / res.off('close') abort wiring both handlers use.
function callRoute(handler: unknown): Promise<Captured> {
  const captured: Captured = { status: 0, body: {} };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      captured.body = payload;
      return this;
    },
    on() {
      return this;
    },
    off() {
      return this;
    },
  };
  const fn = handler as (req: unknown, res: unknown) => Promise<unknown>;
  return Promise.resolve(fn({ query: {} }, res)).then(() => captured);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sysRedis.isReady = true;
  mocks.sysRedis.ping.mockImplementation(async () => 'PONG');
  mocks.redis.isReady = true;
  mocks.dbRead.$transaction.mockImplementation(async () => 1);
  mocks.dbWrite.$transaction.mockImplementation(async () => 1);
  mocks.pgDbRead.query.mockImplementation(async () => ({}));
  mocks.pgDbWrite.query.mockImplementation(async () => ({}));
});

describe('/api/health vs /api/ready — write-check criticality is wired per route', () => {
  // Positive control. Without this, every assertion below could be passing because
  // the harness never reaches the dependency checks at all.
  it('both routes answer OK when every dependency is healthy', async () => {
    const health = await callRoute(healthHandler);
    const ready = await callRoute(readyHandler);
    expect(health.status).toBe(200);
    expect(health.body.healthy).toBe(true);
    expect(ready.status).toBe(200);
    expect(ready.body.ready).toBe(true);
  });

  // THE regression guard: this is the response the load balancer reads, and it is
  // what took the fleet out. Red before the fix (the route answered 500).
  it('write primary down → /api/health stays 200 healthy (pod is NOT shed)', async () => {
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    mocks.pgDbWrite.query.mockRejectedValue(new Error('pg write down'));
    const health = await callRoute(healthHandler);
    expect(health.status).toBe(200);
    expect(health.body.healthy).toBe(true);
    // Observability: the failure is still visible in the response body.
    expect(health.body.write).toBe(false);
    expect(health.body.pgWrite).toBe(false);
  });

  // INVARIANT GUARD, not regression coverage: /api/ready already answered 503 here
  // before the fix, so this pins behaviour the bug never violated. It earns its
  // place because it is exactly what the fix could have broken.
  it('write primary down → /api/ready still 503 (startup fails CLOSED)', async () => {
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    mocks.pgDbWrite.query.mockRejectedValue(new Error('pg write down'));
    const ready = await callRoute(readyHandler);
    expect(ready.status).toBe(503);
    expect(ready.body.ready).toBe(false);
    expect((ready.body.deps as Record<string, boolean>).write).toBe(false);
  });

  // The seam itself, in one assertion: identical broken state, the two routes must
  // DISAGREE. Passes only if /api/ready asks for 'startup' AND /api/health does not.
  it('the SAME broken write primary yields 200 on /api/health and 503 on /api/ready', async () => {
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    const health = await callRoute(healthHandler);
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    const ready = await callRoute(readyHandler);
    expect([health.status, ready.status]).toEqual([200, 503]);
  });

  // A read failure must shed on BOTH routes — the change did not over-broaden at
  // the route level either.
  it('read primary down → /api/health 500 and /api/ready 503 (reads stay critical)', async () => {
    mocks.dbRead.$transaction.mockRejectedValue(new Error('db read down'));
    const health = await callRoute(healthHandler);
    mocks.dbRead.$transaction.mockRejectedValue(new Error('db read down'));
    const ready = await callRoute(readyHandler);
    expect(health.status).toBe(500);
    expect(ready.status).toBe(503);
  });
});
