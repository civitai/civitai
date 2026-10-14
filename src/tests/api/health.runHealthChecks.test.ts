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
  clickhouse: { ping: vi.fn(async () => ({ success: true })) },
  metricsSearchClient: { isHealthy: vi.fn(async () => true) },
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

// clickhouse and meili are mocked as WORKING clients, not as `null`. Both check fns
// early-return `true` when their client is null, so a null fixture makes them structurally
// unbreakable — and a check that cannot fail cannot detect being moved into the non-critical
// set. That blind spot let two set-widening mutants survive a fully green suite.
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: mocks.clickhouse }));

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
  metricsSearchClient: mocks.metricsSearchClient,
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

import { ALL_CHECK_KEYS, runHealthChecks, softCheckKeysForMode } from '~/pages/api/health';
// A leaf module with no runtime imports (its CheckKey import is type-only), so pinning it here
// costs nothing and needs no extra mocks.
import {
  HEALTH_CHECK_LABELS,
  HEALTH_CHECK_ORDER,
} from '~/server/freshdesk-agent/health-check-labels';
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
  mocks.clickhouse.ping.mockImplementation(async () => ({ success: true }));
  mocks.metricsSearchClient.isHealthy.mockImplementation(async () => true);
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

      // Advance past the per-check timeout (1000ms). advanceTimersByTimeAsync also flushes
      // the microtasks between timers, so the fast critical checks settle and the check phase
      // resolves. Note the 2000ms overall deadline does NOT fire in this case — the per-check
      // race resolves the parked ping first — so this exercises the per-check timeout path,
      // not the deadline-fill branch. Advancing well past both keeps the case robust to a
      // HEALTHCHECK_TIMEOUT change; it does not mean the deadline fired.
      await vi.advanceTimersByTimeAsync(2500);

      const { healthy, results } = await runPromise;

      // Parked sysRedis did NOT shed readiness.
      expect(healthy).toBe(true);
      // Observability preserved: the timed-out ping is recorded as a failure.
      // `toBe(false)` not `toBeFalsy()`: a timed-out check resolves to literal false, so
      // toBeFalsy would also accept the key never having been written at all.
      expect(results.sysRedis).toBe(false);
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
      // Past the per-check timeout (1000ms). The per-check race resolves the parked
      // transaction there, so the run completes BEFORE the 2000ms overall deadline — this
      // exercises the per-check timeout path, not the deadline-fill branch. Advancing well
      // past both keeps the case robust if HEALTHCHECK_TIMEOUT changes; it does not mean the
      // deadline fires. (The deadline-fill branch is unexercised for the write checks; noted
      // rather than papered over.)
      await vi.advanceTimersByTimeAsync(2500);
      const { healthy, results } = await runPromise;
      expect(healthy).toBe(true);
      // `toBe(false)` not `toBeFalsy()`: a timed-out check resolves to literal false, and
      // toBeFalsy would also accept `undefined` — i.e. the key never being written at all.
      expect(results.write).toBe(false);
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

  // NOT-OVER-BROADENED, one case per still-critical check. EVERY such check gets a case,
  // not a sample: clickhouse and searchMetrics were omitted at first, and because they were
  // mocked as null they could not fail, so moving either into the soft set survived the
  // whole suite. That was measured, not theoretical.
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
    ['clickhouse', (): void => void mocks.clickhouse.ping.mockResolvedValue({ success: false })],
    [
      'searchMetrics',
      (): void => void mocks.metricsSearchClient.isHealthy.mockResolvedValue(false),
    ],
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
      expect(results.write).toBe(false);
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

// ---------------------------------------------------------------------------
// STRUCTURAL LEDGER over the soft sets.
//
// Everything above is behavioural, and behaviour cannot see the whole hazard: a check whose
// fixture is unbreakable can be moved into the soft set without a single test going red. Two
// mutants — `clickhouse` and `searchMetrics` added to STARTUP_ONLY_CRITICAL_CHECKS — survived
// the full suite for exactly that reason, and the fix for the fixtures does not generalise to
// a check added LATER with a null-client default of its own.
//
// So this pins the resolved sets EXACTLY, and fails when either grows OR shrinks. It is a
// deliberate second belt: a structural assertion type-checks past a wrong behaviour and a
// behavioural one misses an unreachable fixture, so neither alone is sufficient.
//
// If you are here because this test failed: you changed which dependencies can shed a serving
// pod from the load balancer. That is the fleet-wide-outage lever. Update the expectation only
// with the behavioural case to match.
// ---------------------------------------------------------------------------
describe('softCheckKeysForMode — the exact soft set per mode', () => {
  it('readiness mode: sysRedis plus BOTH write checks, and nothing else', () => {
    expect([...softCheckKeysForMode('readiness')].sort()).toEqual(
      ['pgWrite', 'sysRedis', 'write'].sort()
    );
  });

  it('startup mode: sysRedis ONLY — the write checks stay critical at boot', () => {
    expect([...softCheckKeysForMode('startup')].sort()).toEqual(['sysRedis']);
  });

  it.each(['read', 'pgRead', 'redis', 'clickhouse', 'searchMetrics'] as const)(
    '%s is soft in NEITHER mode',
    (key) => {
      expect(softCheckKeysForMode('readiness')).not.toContain(key);
      expect(softCheckKeysForMode('startup')).not.toContain(key);
    }
  );

  // DERIVED from the real check set, not mirrored: the two lists above are hand-written, so a
  // check added to `checkFns` later would simply get no case and nothing would go red. This
  // partitions the ACTUAL keys and fails when the set grows, forcing a deliberate decision
  // about the new check rather than defaulting it into "critical, untested".
  it('every check is accounted for — no check is silently unclassified', () => {
    const soft = new Set(softCheckKeysForMode('readiness'));
    const critical = ALL_CHECK_KEYS.filter((k) => !soft.has(k));
    expect([...soft].sort()).toEqual(['pgWrite', 'sysRedis', 'write'].sort());
    expect(critical.sort()).toEqual(
      ['clickhouse', 'pgRead', 'read', 'redis', 'searchMetrics'].sort()
    );
    // No length assertion here — but NOT for the reason first written down, which was false in
    // the load-bearing direction and is corrected here rather than quietly deleted.
    //
    // The original claim was "the two equalities above trip first on any add/remove/rename".
    // Measured, that is wrong for a SOFT key: `ALL_CHECK_KEYS.filter(k => k !== 'write')` — a
    // runtime-only removal that produces no type error — leaves BOTH equalities green, because
    // `soft` comes from the hardcoded `softCheckKeysForMode` and `critical` is unchanged when
    // the removed key was already soft. For write/pgWrite/sysRedis, `toHaveLength` was the only
    // assertion here that could have failed.
    //
    // The actual division of labour, which is what a future reader needs:
    //   - a TYPED change (a check added to/removed from `checkFns`) dies at the `satisfies` and
    //     at `Record<CheckKey, string>` — compile errors, before any test runs;
    //   - a RUNTIME-ONLY drift dies at the cross-module seam test below, and ONLY there. That
    //     mutant was run: it fails exactly one test, the seam one.
    // So the seam test is not redundant with this one. Do not delete it as such.
  });

  // CROSS-MODULE SEAM. The support-agent status report labels these checks, and its label set
  // used to be a hand-written mirror — so a renamed or removed check arrived there as an absent
  // key, which that report then described as deliberately disabled. The map is typed
  // `Record<CheckKey, string>`, which makes the compiler enforce the same thing; this pins the
  // RUNTIME set, because the type cannot see a key list built at runtime.
  it('the support-agent label map covers exactly the real check set', () => {
    expect(Object.keys(HEALTH_CHECK_LABELS).sort()).toEqual([...ALL_CHECK_KEYS].sort());
    // …and the render order is the same set, not a subset that silently drops a check.
    expect([...HEALTH_CHECK_ORDER].sort()).toEqual([...ALL_CHECK_KEYS].sort());
  });
});
