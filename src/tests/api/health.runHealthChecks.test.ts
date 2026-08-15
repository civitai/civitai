import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Unit test for runHealthChecks' overall-health computation, focused on the
// sysRedis SOFT-dependency rule: a failing sysRedis check must NOT flip the
// overall `healthy` boolean (readiness must not shed the fleet), yet the
// sysRedis result must still be recorded in the per-check results (metric /
// observability preserved). A genuinely-critical check (DB) failing MUST still
// flip `healthy` to false (the fix is scoped to sysRedis only).
//
// health.ts pulls a large dependency graph (db, pg, meili, clickhouse, redis,
// prom, env). We mock those modules so the check functions are deterministic
// and controllable per-test; the real logic under test is runHealthChecks'
// `healthy` computation. Mirrors the mocking approach in
// src/server/__tests__/live-endpoint.test.ts.

// Mutable, hoisted mock backing objects. The check fns read properties off
// these SAME references at call time, so mutating a method here (per test)
// changes what the corresponding check returns without re-importing.
const mocks = vi.hoisted(() => ({
  pgDbRead: { query: vi.fn(async () => ({})) },
  pgDbWrite: { query: vi.fn(async () => ({})) },
}));

vi.mock('~/env/other', () => ({
  // isProd=false skips the prod-only sysRedis config-read leg entirely, so the
  // runtime `nonCriticalChecks` list is []. This proves sysRedis is treated as
  // non-critical PURELY from the static hardcoded set — no sysRedis read
  // involved (the whole point: the runtime lever is self-defeating).
  isProd: false,
  isDev: false,
  isTest: true,
}));

vi.mock('~/env/server', () => ({
  env: {
    HEALTHCHECK_TIMEOUT: 1000,
    HEALTHCHECK_DISABLED: [] as string[],
  },
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

// The hand-written REDIS_SYS_KEYS this file used to carry invented a `sys:` prefix on all
// three keys (the real ones are `disabled-healthchecks`, `non-critical-healthchecks`,
// `system:features`). Nothing asserted on them — isProd is false, so the config-read leg is
// inert — so the copy was never wrong in a way anything could see. The canonical
// registration spreads the real constant.

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

vi.mock('~/utils/number-helpers', () => ({ getRandomInt: () => 123 }));

import { runHealthChecks } from '~/pages/api/health';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// A never-aborted signal so runHealthChecks runs the full check set.
const liveSignal = () => new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset every backing mock to the HEALTHY default before each test.
  redisMock.sysRedis.isReady = true;
  redisMock.sysRedis.ping.mockImplementation(async () => 'PONG');
  redisMock.redis.isReady = true;
  dbMock.dbRead.$transaction.mockImplementation(async () => 1);
  dbMock.dbWrite.$transaction.mockImplementation(async () => 1);
  mocks.pgDbRead.query.mockImplementation(async () => ({}));
  mocks.pgDbWrite.query.mockImplementation(async () => ({}));
});

// `isReady` is a plain data property, not a spy, so it is written straight onto the canonical
// node and `resetSharedMocks()` — which resets mock functions — does not clear it. Under
// `isolate: false` that would leave `sysRedis.isReady === false` for every later file in this
// worker. Restore it here so the leak cannot escape this file.
afterEach(() => {
  redisMock.sysRedis.isReady = true;
  redisMock.redis.isReady = true;
});

describe('runHealthChecks — sysRedis soft dependency', () => {
  it('baseline: all deps healthy → healthy true, sysRedis true', async () => {
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(true);
    expect(results.sysRedis).toBe(true);
  });

  it('sysRedis ping returns non-PONG → still healthy, sysRedis result recorded false', async () => {
    redisMock.sysRedis.ping.mockImplementation(async () => 'NOPE');
    const { healthy, results } = await runHealthChecks(liveSignal());
    // Fleet NOT shed despite sysRedis failing.
    expect(healthy).toBe(true);
    // Observability preserved: the failure is still in the per-check results.
    expect(results.sysRedis).toBe(false);
  });

  it('sysRedis ping throws → still healthy, sysRedis result recorded false', async () => {
    redisMock.sysRedis.ping.mockImplementation(async () => {
      throw new Error('sysRedis connection refused');
    });
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(true);
    expect(results.sysRedis).toBe(false);
  });

  it('sysRedis isReady false → still healthy, sysRedis result recorded false', async () => {
    redisMock.sysRedis.isReady = false;
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(true);
    expect(results.sysRedis).toBe(false);
  });

  it('did NOT over-broaden: a critical check (dbRead) failing DOES flip healthy false', async () => {
    dbMock.dbRead.$transaction.mockRejectedValue(new Error('db read down'));
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(false);
    expect(results.read).toBe(false);
    // sysRedis unaffected here (still healthy) — its result stands on its own.
    expect(results.sysRedis).toBe(true);
  });

  it('critical failing AND sysRedis failing → healthy false (sysRedis never rescues a real failure)', async () => {
    dbMock.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    redisMock.sysRedis.ping.mockImplementation(async () => 'NOPE');
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(false);
    expect(results.write).toBe(false);
    expect(results.sysRedis).toBe(false);
  });

  // THE load-bearing case this PR exists for: a sysRedis ping that PARKS (never
  // settles — the slow half-open Sentinel-cutover failure, not a fast throw).
  // The per-check `runCheckWithTimeout` race bounds the parked ping at
  // HEALTHCHECK_TIMEOUT (1000ms) — well under the overall deadline (2000ms) —
  // resolving it as a `timeout` → false. Because sysRedis is STATICALLY
  // non-critical, the overall `healthy` must still resolve TRUE within the
  // deadline: readiness is NOT shed while sysRedis is parked. All critical
  // checks stay fast/healthy so the ONLY slow thing is the sysRedis ping,
  // proving the parked ping alone doesn't shed the fleet.
  //
  // Fake timers drive the per-check setTimeout race deterministically (the
  // ping promise never settles, so only the timer can end the race).
  // Guard property: if the static-non-critical gate were removed, this parked
  // ping resolves sysRedis=false as a CRITICAL check → healthy=false → the
  // `expect(healthy).toBe(true)` below fails. So this is a real regression
  // guard, not just an exercise of the timeout path.
  it('sysRedis ping PARKS (never settles) → still healthy within deadline, sysRedis recorded falsy', async () => {
    vi.useFakeTimers();
    try {
      // Never-resolving promise: the ONLY way this check ends is the per-check
      // wall-clock timeout inside runCheckWithTimeout.
      redisMock.sysRedis.ping.mockImplementation(() => new Promise<string>(() => {}));

      const runPromise = runHealthChecks(liveSignal());

      // Advance past the per-check timeout (1000ms) and the overall deadline
      // (2000ms). advanceTimersByTimeAsync also flushes the microtasks between
      // timers, so the fast critical checks settle and the check phase resolves.
      await vi.advanceTimersByTimeAsync(2500);

      const { healthy, results } = await runPromise;

      // Parked sysRedis did NOT shed readiness.
      expect(healthy).toBe(true);
      // Observability preserved: the timed-out ping is recorded as a failure.
      expect(results.sysRedis).toBeFalsy();
      // A genuinely-critical dep resolved fine (only sysRedis was slow).
      expect(results.write).toBe(true);
      expect(results.read).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
