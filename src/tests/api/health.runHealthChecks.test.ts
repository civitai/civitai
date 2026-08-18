import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  // Prom handles are captured (not thrown away) so the tests can assert that a
  // check made NON-CRITICAL still EMITS — the observability half of the contract.
  // registerCounter is called once per check at module init, keyed by metric name
  // (`healthcheck_<lowercased check>`), so the map is populated on import.
  promCounters: {} as Record<string, { inc: ReturnType<typeof vi.fn> }>,
  attemptsCounter: { inc: vi.fn() },
  durationHistogram: { observe: vi.fn() },
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
  withMeiliHealthProbe: (fn: () => Promise<boolean>) => fn(),
  MeiliCallTimeoutError: class MeiliCallTimeoutError extends Error {},
}));

vi.mock('~/server/prom/client', () => ({
  registerCounter: ({ name }: { name: string }) => (mocks.promCounters[name] ??= { inc: vi.fn() }),
  registerCounterWithLabels: () => mocks.attemptsCounter,
  registerHistogram: () => mocks.durationHistogram,
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

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

vi.mock('~/utils/number-helpers', () => ({ getRandomInt: () => 123 }));

import { runHealthChecks } from '~/pages/api/health';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// A never-aborted signal so runHealthChecks runs the full check set.
const liveSignal = () => new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
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

  // Repointed from dbWrite to dbRead: `write` is no longer critical on the default
  // (readiness) path, so a dbWrite failure can no longer demonstrate "sysRedis
  // never rescues a real failure". dbRead is still critical in both modes, so it
  // tests the original property. The dbWrite-specific behaviour it used to cover
  // is now pinned deliberately, in both directions, in the DB-write describe below.
  it('critical failing AND sysRedis failing → healthy false (sysRedis never rescues a real failure)', async () => {
    mocks.dbRead.$transaction.mockRejectedValue(new Error('db read down'));
    mocks.sysRedis.ping.mockImplementation(async () => 'NOPE');
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(false);
    expect(results.read).toBe(false);
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

// ---------------------------------------------------------------------------
// The DB write checks (`write` = Prisma dbWrite, `pgWrite` = pg pool) are a
// SHARED dependency, so a stall on the write primary fails them on every replica
// inside one probe window and empties the load balancer. They are therefore
// soft for steady-state readiness (/api/health) and hard for startup
// (/api/ready) — see STARTUP_ONLY_CRITICAL_CHECKS in health.ts.
//
// Every case below states which direction it pins: NON-SHEDDING (the regression
// the incident produced), FAIL-CLOSED (startup must not regress), or
// NOT-OVER-BROADENED (checks that must still shed).
// ---------------------------------------------------------------------------
describe('runHealthChecks — DB write soft dependency (steady-state readiness)', () => {
  it('baseline: all deps healthy → healthy true, both write checks true', async () => {
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(true);
    expect(results.write).toBe(true);
    expect(results.pgWrite).toBe(true);
  });

  // NON-SHEDDING. The Prisma write check is what failed in the incident.
  it('dbWrite throws → still healthy, write recorded false', async () => {
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(true);
    expect(results.write).toBe(false);
  });

  // NON-SHEDDING. pgWrite is a SEPARATE client over a separate pool; it must be
  // soft on its own, or it re-arms the fleet shed by itself.
  it('pgWrite throws → still healthy, pgWrite recorded false', async () => {
    mocks.pgDbWrite.query.mockRejectedValue(new Error('pg write down'));
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(true);
    expect(results.pgWrite).toBe(false);
  });

  // NON-SHEDDING, and the actual incident shape: both write checks fail together
  // because they share one primary. Listing only one of them would leave this red.
  it('BOTH write checks fail together → still healthy, both recorded false', async () => {
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    mocks.pgDbWrite.query.mockRejectedValue(new Error('pg write down'));
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(true);
    expect(results.write).toBe(false);
    expect(results.pgWrite).toBe(false);
    // Reads were unaffected in the incident and must be unaffected here.
    expect(results.read).toBe(true);
    expect(results.pgRead).toBe(true);
  });

  // NON-SHEDDING, explicit mode. Proves the parameter is honoured rather than
  // the default happening to be lenient for some other reason.
  it("mode 'readiness' passed explicitly → same non-shedding result as the default", async () => {
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    const { healthy } = await runHealthChecks(liveSignal(), { mode: 'readiness' });
    expect(healthy).toBe(true);
  });

  // NON-SHEDDING, and the load-bearing shape: the production failure was a
  // connection-pool ACQUISITION hang, not a fast throw — Prisma parked until it
  // gave up. statement_timeout does not bound acquisition, so the only ceiling is
  // the per-check runCheckWithTimeout race. A fast-throw test alone would not
  // cover the path the incident actually took.
  it('dbWrite PARKS (acquisition hang) → still healthy within deadline, write falsy', async () => {
    vi.useFakeTimers();
    try {
      mocks.dbWrite.$transaction.mockImplementation(() => new Promise(() => {}));
      const runPromise = runHealthChecks(liveSignal());
      // Past the per-check timeout (1000ms) and the overall deadline (2000ms).
      await vi.advanceTimersByTimeAsync(2500);
      const { healthy, results } = await runPromise;
      expect(healthy).toBe(true);
      expect(results.write).toBeFalsy();
      // Only the write check was slow; the critical ones resolved fine.
      expect(results.read).toBe(true);
      expect(results.pgRead).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // NOT-OVER-BROADENED: `write` being soft must never rescue a genuinely
  // critical failure that happens at the same time.
  it('write soft + read failing → healthy false (softness never rescues a critical check)', async () => {
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    mocks.dbRead.$transaction.mockRejectedValue(new Error('db read down'));
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(false);
    expect(results.write).toBe(false);
    expect(results.read).toBe(false);
  });

  // NOT-OVER-BROADENED, one case per still-critical check. A pod that cannot read
  // is useless and SHOULD leave the pool.
  it.each([
    // Thunks are annotated `(): void` deliberately: a bare arrow returning
    // `mockRejectedValue(...)` returns the mock itself, which makes its return type
    // reference the mock's own type and trips TS7024 (circular implicit any).
    [
      'read',
      (): void => void mocks.dbRead.$transaction.mockRejectedValue(new Error('db read down')),
    ],
    ['pgRead', (): void => void mocks.pgDbRead.query.mockRejectedValue(new Error('pg read down'))],
    ['redis', (): void => void (mocks.redis.isReady = false)],
  ] as const)('%s stays critical on the readiness path → healthy false', async (key, breakIt) => {
    breakIt();
    const { healthy, results } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(false);
    expect(results[key]).toBe(false);
  });

  // OBSERVABILITY: the check must still RUN and still EMIT after it stops gating
  // readiness — the operator's only signal during the incident. Asserts the check
  // was actually invoked (not disabled), its per-check counter and the labelled
  // attempts counter fired, the duration histogram observed it, and the `overall`
  // counter did NOT fire (nothing was shed).
  it('a non-critical write failure still runs the check and emits its metrics', async () => {
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    const { healthy, results } = await runHealthChecks(liveSignal());

    expect(healthy).toBe(true);
    expect(results.write).toBe(false);
    // Still RUNNING (this is what HEALTHCHECK_DISABLED would have broken).
    expect(mocks.dbWrite.$transaction).toHaveBeenCalled();
    // Per-check failure counter.
    expect(mocks.promCounters['healthcheck_write'].inc).toHaveBeenCalled();
    // Labelled attempt outcome.
    expect(mocks.attemptsCounter.inc).toHaveBeenCalledWith({ name: 'write', result: 'failure' });
    // Duration observed.
    expect(mocks.durationHistogram.observe).toHaveBeenCalledWith(
      { name: 'write' },
      expect.any(Number)
    );
    // The overall counter is the "readiness was shed" signal — it must NOT fire.
    expect(mocks.promCounters['healthcheck_overall'].inc).not.toHaveBeenCalled();
  });

  it('a healthy run does not increment the write failure counter (positive control)', async () => {
    const { healthy } = await runHealthChecks(liveSignal());
    expect(healthy).toBe(true);
    expect(mocks.promCounters['healthcheck_write'].inc).not.toHaveBeenCalled();
    expect(mocks.attemptsCounter.inc).toHaveBeenCalledWith({ name: 'write', result: 'success' });
  });
});

describe("runHealthChecks — mode 'startup' still fails CLOSED on the DB", () => {
  // Baseline first, so the fail-closed cases below cannot pass vacuously.
  it('baseline: all deps healthy in startup mode → healthy true', async () => {
    const { healthy } = await runHealthChecks(liveSignal(), { mode: 'startup' });
    expect(healthy).toBe(true);
  });

  // FAIL-CLOSED: a pod that has never reached the DB must not enter the pool.
  it.each([
    [
      'write',
      (): void => void mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down')),
    ],
    [
      'pgWrite',
      (): void => void mocks.pgDbWrite.query.mockRejectedValue(new Error('pg write down')),
    ],
  ] as const)('%s failing in startup mode → healthy false', async (key, breakIt) => {
    breakIt();
    const { healthy, results } = await runHealthChecks(liveSignal(), { mode: 'startup' });
    expect(healthy).toBe(false);
    expect(results[key]).toBe(false);
  });

  it('BOTH write checks failing in startup mode → healthy false', async () => {
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    mocks.pgDbWrite.query.mockRejectedValue(new Error('pg write down'));
    const { healthy } = await runHealthChecks(liveSignal(), { mode: 'startup' });
    expect(healthy).toBe(false);
  });

  // FAIL-CLOSED on the acquisition-hang shape too, not just a fast throw: a pod
  // whose first DB contact hangs must not be declared started.
  it('dbWrite PARKS in startup mode → healthy false', async () => {
    vi.useFakeTimers();
    try {
      mocks.dbWrite.$transaction.mockImplementation(() => new Promise(() => {}));
      const runPromise = runHealthChecks(liveSignal(), { mode: 'startup' });
      await vi.advanceTimersByTimeAsync(2500);
      const { healthy, results } = await runPromise;
      expect(healthy).toBe(false);
      expect(results.write).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  // NOT-OVER-BROADENED in the other direction: startup mode must not make
  // sysRedis critical again. Its softness is independent of this change.
  it('sysRedis failing in startup mode → still healthy (sysRedis stays soft in BOTH modes)', async () => {
    mocks.sysRedis.ping.mockImplementation(async () => 'NOPE');
    const { healthy, results } = await runHealthChecks(liveSignal(), { mode: 'startup' });
    expect(healthy).toBe(true);
    expect(results.sysRedis).toBe(false);
  });

  // The two modes must actually DISAGREE on the same input — the one assertion
  // that cannot pass if the mode parameter is ignored in either direction.
  it('the SAME dbWrite failure yields healthy true on readiness and false on startup', async () => {
    mocks.dbWrite.$transaction.mockRejectedValue(new Error('db write down'));
    const readiness = await runHealthChecks(liveSignal(), { mode: 'readiness' });
    const startup = await runHealthChecks(liveSignal(), { mode: 'startup' });
    expect(readiness.healthy).toBe(true);
    expect(startup.healthy).toBe(false);
  });
});
