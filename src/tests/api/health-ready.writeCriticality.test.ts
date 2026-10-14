import { describe, it, expect, vi, beforeEach } from 'vitest';
// Canonical shared mocks for `~/server/db/client` and `~/server/redis/client`. This file must
// NOT `vi.mock` either specifier itself — under `isolate: false` a per-file registration
// freezes that file's mock shape into every later file in the same worker. Enforced by
// src/server/services/__tests__/no-direct-shared-module-mock.test.ts; see
// docs/testing/shared-module-mocks.md.
import { dbMock, redisMock, resetSharedMocks } from '~/__tests__/mocks';

// ROUTE-LEVEL SEAM TEST.
//
// health.runHealthChecks.test.ts proves runHealthChecks itself treats the DB write checks as
// soft for 'readiness' and hard for 'startup'. That proves NOTHING about which mode each
// ROUTE asks for — the two surfaces are tested separately, and the defect that matters lives
// in the seam: /api/ready dropping its `{ mode: 'startup' }` argument, or /api/health
// acquiring one, would leave every unit test green while either failing closed across the
// whole fleet or letting a never-connected pod into the pool.
//
// So this file exercises the HANDLERS and asserts the relationship between them: with an
// identical broken write primary, /api/health must answer 200 healthy and /api/ready must
// answer 503 not-ready. Nothing but correct wiring on BOTH sides satisfies both halves.

// pgDb has no canonical mock, so it is mocked here. Same for the small leaf modules below.
const mocks = vi.hoisted(() => ({
  pgDbRead: { query: vi.fn(async () => ({})) },
  pgDbWrite: { query: vi.fn(async () => ({})) },
}));

vi.mock('~/env/other', () => ({ isProd: false, isDev: false, isTest: true }));
// Kept local rather than taken from the shared env mock: HEALTHCHECK_TIMEOUT is what bounds
// every per-check race, and an undefined value would make the timeouts fire immediately.
vi.mock('~/env/server', () => ({
  env: { HEALTHCHECK_TIMEOUT: 1000, HEALTHCHECK_DISABLED: [] as string[] },
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
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
// WebhookEndpoint is the `?token` gate; unwrap it so the handler is callable.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/utils/number-helpers', () => ({ getRandomInt: () => 123 }));
// /api/ready gates on warmth BEFORE it runs any dependency check. Report warm so the dep
// checks actually execute — an unwarm pod 503s for an unrelated reason, which would make
// every assertion below vacuous.
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
function callRoute(handler: unknown, query: Record<string, string> = {}): Promise<Captured> {
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
  return Promise.resolve(fn({ query }, res)).then(() => captured);
}

// Break a dependency for one test. Named so each case reads as the state it creates rather
// than as mock plumbing.
const breakPrismaWrite = () =>
  void dbMock.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
const breakPgWrite = () => void mocks.pgDbWrite.query.mockRejectedValue(new Error('pg write down'));
const breakPrismaRead = () =>
  void dbMock.dbRead.$transaction.mockRejectedValue(new Error('db read down'));

beforeEach(() => {
  // Restores every shared-mock node to its registered default (including $transaction's
  // run-the-callback behaviour) — `clearAllMocks` would only drop call history and leave a
  // previous test's mockRejectedValue in place.
  resetSharedMocks();
  mocks.pgDbRead.query.mockImplementation(async () => ({}));
  mocks.pgDbWrite.query.mockImplementation(async () => ({}));
  // The canonical sysRedis node answers undefined by default, which the sysRedis check reads
  // as unhealthy. Make the baseline genuinely all-healthy so the positive control below is
  // testing what it claims.
  redisMock.sysRedis.ping.mockResolvedValue('PONG');
});

describe('/api/health vs /api/ready — write-check criticality is wired per route', () => {
  // Positive control. Without this, every assertion below could be passing because the
  // harness never reaches the dependency checks at all.
  it('both routes answer OK when every dependency is healthy', async () => {
    const health = await callRoute(healthHandler);
    const ready = await callRoute(readyHandler);
    expect(health.status).toBe(200);
    expect(health.body.healthy).toBe(true);
    expect(ready.status).toBe(200);
    expect(ready.body.ready).toBe(true);
  });

  // THE regression guard: this is the response the load balancer reads, and it is what took
  // the fleet out. Red before the fix (the route answered 500).
  it('write primary down → /api/health stays 200 healthy (pod is NOT shed)', async () => {
    breakPrismaWrite();
    breakPgWrite();
    const health = await callRoute(healthHandler);
    expect(health.status).toBe(200);
    expect(health.body.healthy).toBe(true);
    // Observability: the failure is still visible in the response body.
    expect(health.body.write).toBe(false);
    expect(health.body.pgWrite).toBe(false);
  });

  // INVARIANT GUARD, not regression coverage: /api/ready already answered 503 here before the
  // fix, so this pins behaviour the bug never violated. It earns its place because it is
  // exactly what the fix could have broken.
  it('write primary down → /api/ready still 503 (startup fails CLOSED)', async () => {
    breakPrismaWrite();
    breakPgWrite();
    const ready = await callRoute(readyHandler);
    expect(ready.status).toBe(503);
    expect(ready.body.ready).toBe(false);
    expect((ready.body.deps as Record<string, boolean>).write).toBe(false);
  });

  // The seam itself, in one assertion: identical broken state, the two routes must DISAGREE.
  // Passes only if /api/ready asks for 'startup' AND /api/health does not.
  it('the SAME broken write primary yields 200 on /api/health and 503 on /api/ready', async () => {
    breakPrismaWrite();
    const health = await callRoute(healthHandler);
    const ready = await callRoute(readyHandler);
    expect([health.status, ready.status]).toEqual([200, 503]);
  });

  // 🔴 `?startup=true` must stay INERT on this route.
  //
  // Every readiness probe URL in the deployment manifests carries `&startup=true`, and the
  // handler does not read `req.query` at all — so the parameter does nothing today. That makes
  // it a footgun: a future reader who "finishes the wiring" by mapping it to
  // `mode: 'startup'` would instantly convert every readiness probe to fail-closed and
  // re-arm the whole-fleet shed this change exists to prevent.
  //
  // A comment cannot stop that; this can. The route must answer identically with and without
  // the parameter, so wiring it up turns this red instead of turning up in production.
  it('?startup=true is INERT on /api/health — same answer with and without it', async () => {
    breakPrismaWrite();
    breakPgWrite();
    const withParam = await callRoute(healthHandler, { startup: 'true', token: 'x' });
    const withoutParam = await callRoute(healthHandler);
    expect(withParam.status).toBe(200);
    expect(withParam.body.healthy).toBe(true);
    // Compare the WHOLE response, not a couple of fields — "same answer" should mean it.
    // `podname` and `version` are dropped because they are environment, not health. (Both are
    // in fact deterministic in this file — getRandomInt is mocked — so this is defensive, and
    // keeps the assertion honest if that mock ever goes away.)
    const comparable = ({ podname: _p, version: _v, ...rest }: Record<string, unknown>) => rest;
    expect(comparable(withParam.body)).toEqual(comparable(withoutParam.body));
    expect(withParam.status).toBe(withoutParam.status);
  });

  // A read failure must shed on BOTH routes — the change did not over-broaden at the route
  // level either.
  it('read primary down → /api/health 500 and /api/ready 503 (reads stay critical)', async () => {
    breakPrismaRead();
    const health = await callRoute(healthHandler);
    const ready = await callRoute(readyHandler);
    expect(health.status).toBe(500);
    expect(ready.status).toBe(503);
  });
});
