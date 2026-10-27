import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

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
  sysRedis: {
    isReady: true,
    ping: vi.fn(async () => 'PONG'),
    // hGet is only touched in the prod config-read leg; isProd is mocked false
    // below so this stays inert, but provide it so the import is faithful.
    hGet: vi.fn(async () => '[]'),
  },
  redis: { isReady: true },
  dbRead: { $transaction: vi.fn(async () => 1) },
  dbWrite: { $transaction: vi.fn(async () => 1) },
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

vi.mock('~/server/db/client', () => ({
  dbRead: mocks.dbRead,
  dbWrite: mocks.dbWrite,
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbReadLong: {},
  pgDbRead: mocks.pgDbRead,
  pgDbWrite: mocks.pgDbWrite,
}));

vi.mock('~/server/meilisearch/client', () => ({
  metricsSearchClient: null,
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
      DISABLED_HEALTHCHECKS: 'disabled-healthchecks',
      NON_CRITICAL_HEALTHCHECKS: 'non-critical-healthchecks',
      FEATURES: 'system:features',
    },
  },
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

vi.mock('~/utils/number-helpers', () => ({ getRandomInt: () => 123 }));

vi.mock('~/server/warmup', () => ({
  isWarm: () => true,
  getWarmState: () => 'warmed-ok',
  getWarmDurationMs: () => 0,
  didFailOpenTimeout: () => false,
}));

import healthHandler, {
  resetHealthCheckReuseForTests,
  runHealthChecks,
  runHealthChecksReusingCleanRun,
} from '~/pages/api/health';
import readyHandler from '~/pages/api/ready';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// A never-aborted signal so runHealthChecks runs the full check set.
const liveSignal = () => new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  resetHealthCheckReuseForTests();
  // Reset every backing mock to the HEALTHY default before each test.
  mocks.sysRedis.isReady = true;
  mocks.sysRedis.ping.mockImplementation(async () => 'PONG');
  mocks.redis.isReady = true;
  mocks.dbRead.$transaction.mockImplementation(async () => 1);
  mocks.dbWrite.$transaction.mockImplementation(async () => 1);
  mocks.pgDbRead.query.mockImplementation(async () => ({}));
  mocks.pgDbWrite.query.mockImplementation(async () => ({}));
});

describe('runHealthChecks — sysRedis soft dependency', () => {
  it('baseline: all deps healthy → healthy true, sysRedis true', async () => {
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(true);
    expect(results.sysRedis).toBe(true);
  });

  it('runs exactly the live dependency checks: the retired feeds Meilisearch is not one', async () => {
    // `searchMetrics` probed the feeds Meilisearch (METRICS_SEARCH_HOST), retired in HQ
    // 793s8c2maetp. Pinned as the whole set so a re-added or dropped check is reviewed.
    const { results } = await runHealthChecks(liveSignal());
    expect(Object.keys(results).sort()).toEqual(
      ['clickhouse', 'pgRead', 'pgWrite', 'read', 'redis', 'sysRedis', 'write'].sort()
    );
  });

  it('sysRedis ping returns non-PONG → still healthy, sysRedis result recorded false', async () => {
    mocks.sysRedis.ping.mockImplementation(async () => 'NOPE');
    const { healthy, results } = await runHealthChecks(liveSignal());
    // Fleet NOT shed despite sysRedis failing.
    expect(healthy).toBe(true);
    // Observability preserved: the failure is still in the per-check results.
    expect(results.sysRedis).toBe(false);
  });

  it('sysRedis ping throws → still healthy, sysRedis result recorded false', async () => {
    mocks.sysRedis.ping.mockImplementation(async () => {
      throw new Error('sysRedis connection refused');
    });
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(true);
    expect(results.sysRedis).toBe(false);
  });

  it('sysRedis isReady false → still healthy, sysRedis result recorded false', async () => {
    mocks.sysRedis.isReady = false;
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(true);
    expect(results.sysRedis).toBe(false);
  });

  it('did NOT over-broaden: a critical check (dbRead) failing DOES flip healthy false', async () => {
    mocks.dbRead.$transaction.mockRejectedValue(new Error('db read down'));
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(false);
    expect(results.read).toBe(false);
    // sysRedis unaffected here (still healthy) — its result stands on its own.
    expect(results.sysRedis).toBe(true);
  });

  it('critical failing AND sysRedis failing → healthy false (sysRedis never rescues a real failure)', async () => {
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    mocks.sysRedis.ping.mockImplementation(async () => 'NOPE');
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
      mocks.sysRedis.ping.mockImplementation(() => new Promise<string>(() => {}));

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

// /api/health reuses a run in which every check passed for 10 s, so a probe every few seconds does
// not hit every dependency each time. Only a clean sweep is reused. The reuse slot is module-level,
// so the file-wide beforeEach resets it.
describe('/api/health reuses a recent clean run', () => {
  let now = 1_000_000;

  let clock: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    clock?.mockRestore();
  });

  const probe = async (handler: typeof healthHandler) => {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      on: vi.fn(),
      off: vi.fn(),
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        res.body = body;
        return res;
      },
    };
    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)({}, res);
    return res;
  };

  it('a second /api/health probe inside the window does not re-run the dependency checks', async () => {
    const first = await probe(healthHandler);
    now += 5_000;
    const second = await probe(healthHandler);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toMatchObject({ healthy: true, write: true, read: true, sysRedis: true });
    expect(mocks.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.pgDbRead.query).toHaveBeenCalledTimes(1);
    expect(mocks.sysRedis.ping).toHaveBeenCalledTimes(1);
  });

  it('/api/ready never reuses a verdict: it runs the full suite after a clean /api/health run', async () => {
    await probe(healthHandler);
    now += 2_000;
    const ready = await probe(readyHandler);

    expect(ready.statusCode).toBe(200);
    expect(mocks.dbWrite.$transaction).toHaveBeenCalledTimes(2);
  });

  it('control: once the window has passed the full suite runs again', async () => {
    await probe(healthHandler);
    now += 9_999;
    await probe(healthHandler);
    expect(mocks.dbWrite.$transaction).toHaveBeenCalledTimes(1);

    now += 1; // exactly 10 s after the clean run started
    await probe(healthHandler);
    expect(mocks.dbWrite.$transaction).toHaveBeenCalledTimes(2);
  });

  it('a run whose caller disconnected is not reused, even if every check passed', async () => {
    const controller = new AbortController();
    const aborted = runHealthChecksReusingCleanRun(controller.signal);
    controller.abort();
    await aborted;

    now += 1_000;
    await probe(healthHandler);

    expect(mocks.dbWrite.$transaction).toHaveBeenCalledTimes(2);
  });

  it('a failing run is never reused, and recovery is seen on the very next probe', async () => {
    mocks.dbRead.$transaction.mockRejectedValue(new Error('db read down'));
    const failing = await probe(healthHandler);
    now += 1_000;
    const stillFailing = await probe(healthHandler);

    mocks.dbRead.$transaction.mockImplementation(async () => 1);
    now += 1_000;
    const recovered = await probe(healthHandler);

    expect(failing.statusCode).toBe(500);
    expect(stillFailing.statusCode).toBe(500);
    expect(recovered.statusCode).toBe(200);
    expect(mocks.dbRead.$transaction).toHaveBeenCalledTimes(3);
  });

  it('a healthy run with a soft-failing dependency is not reused', async () => {
    mocks.sysRedis.ping.mockImplementation(async () => 'NOPE');
    const first = await probe(healthHandler);
    now += 1_000;
    await probe(healthHandler);

    expect(first.statusCode).toBe(200);
    expect(mocks.sysRedis.ping).toHaveBeenCalledTimes(2);
  });

  it('a slow failing run that finishes after a newer clean run evicts it', async () => {
    let failSlow!: () => void;
    mocks.dbRead.$transaction.mockImplementationOnce(
      () => new Promise<number>((_, reject) => (failSlow = () => reject(new Error('db read down'))))
    );
    const slowFailing = probe(healthHandler);

    now += 1_000;
    const clean = await probe(healthHandler);

    now += 1_000;
    failSlow();
    expect((await slowFailing).statusCode).toBe(500);

    now += 1_000;
    await probe(healthHandler);

    expect(clean.statusCode).toBe(200);
    expect(mocks.dbRead.$transaction).toHaveBeenCalledTimes(3);
  });

  it('the test reset also forgets the last failure, so a fresh clean run is reused', async () => {
    mocks.dbRead.$transaction.mockRejectedValueOnce(new Error('db read down'));
    await probe(healthHandler);

    resetHealthCheckReuseForTests();
    now -= 5_000; // a clock reading earlier than that failure, as in a fresh test file
    await probe(healthHandler);
    now += 1_000;
    await probe(healthHandler);

    expect(mocks.dbRead.$transaction).toHaveBeenCalledTimes(2);
  });

  it('a slow clean run that finishes after a newer failing run does not mask the failure', async () => {
    let releaseSlow!: () => void;
    mocks.dbWrite.$transaction.mockImplementationOnce(
      () => new Promise<number>((resolve) => (releaseSlow = () => resolve(1)))
    );
    const slowClean = probe(healthHandler);

    now += 1_000;
    mocks.dbRead.$transaction.mockRejectedValueOnce(new Error('db read down'));
    const failing = await probe(healthHandler);

    now += 1_000;
    releaseSlow();
    expect((await slowClean).statusCode).toBe(200);

    now += 1_000;
    const next = await probe(healthHandler);

    expect(failing.statusCode).toBe(500);
    expect(next.statusCode).toBe(200);
    expect(mocks.dbRead.$transaction).toHaveBeenCalledTimes(3);
  });

  it('a dependency that breaks after a clean run is reported once the window ends', async () => {
    await probe(healthHandler);
    // A read failure, which every criticality rule treats as fatal.
    mocks.dbRead.$transaction.mockRejectedValue(new Error('db read down'));
    now += 9_000;
    const inWindow = await probe(healthHandler);
    now += 1_001;
    const afterWindow = await probe(healthHandler);

    expect(inWindow.statusCode).toBe(200);
    expect(afterWindow.statusCode).toBe(500);
    expect(afterWindow.body).toMatchObject({ healthy: false, read: false });
  });
});
