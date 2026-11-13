import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The background dependency-health metrics loop. What a caller relies on:
//  - it runs the SAME checks as the probes and the healthcheck metrics move (the metric is the
//    product here: alerts read it, and nothing else increments it once the probe stops);
//  - it never overlaps, never throws, keeps a fixed rate, can be switched off, does not hold the
//    process open, and never makes the readiness probe wait.
//
// The Prisma and Redis clients are the canonical shared mocks (registered by the global setup:
// healthy by default); the pg pools are mocked here. The metrics are REAL prom-client metrics on
// the real shared registry, which is what /api/metrics scrapes.

const mocks = vi.hoisted(() => ({
  pgDbRead: { query: vi.fn(async () => ({})) },
  pgDbWrite: { query: vi.fn(async () => ({})) },
}));

vi.mock('~/env/other', () => ({ isProd: false, isDev: false, isTest: true }));
vi.mock('~/env/server', () => ({
  env: { HEALTHCHECK_TIMEOUT: 1000, HEALTHCHECK_DISABLED: [] as string[] },
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/db/pgDb', () => ({
  pgDbReadLong: {},
  pgDbRead: mocks.pgDbRead,
  pgDbWrite: mocks.pgDbWrite,
}));
// The app shim pulls in the db pools; the three things the checks use come from the package.
vi.mock('~/server/prom/client', async () => {
  const t = await import('@civitai/telemetry/client');
  return {
    instrumentationRegistry: t.instrumentationRegistry,
    PROM_PREFIX: t.PROM_PREFIX,
    registerInstrumentationMetric: t.registerInstrumentationMetric,
  };
});
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ProbeEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/utils/number-helpers', () => ({ getRandomInt: () => 123 }));

import { instrumentationRegistry } from '@civitai/telemetry/client';
import client from 'prom-client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import healthHandler, { resetHealthCheckReuseForTests } from '~/pages/api/health';
import {
  getLastProbeRunStartedAt,
  resetProbeRunStampForTests,
  runHealthChecks,
} from '~/server/health/dependency-checks';
import {
  resolveHealthMetricsIntervalMs,
  startHealthMetricsLoop,
  startHealthMetricsLoopWhenWarm,
  WARM_MAX_WAIT_MS,
} from '~/server/health/metrics-loop';

const ALL_CHECKS = ['clickhouse', 'pgRead', 'pgWrite', 'read', 'redis', 'sysRedis', 'write'];

async function attempts(name: string, result: string): Promise<number> {
  const metric = instrumentationRegistry.getSingleMetric('civitai_app_healthcheck_attempts_total');
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.find((v) => v.labels.name === name && v.labels.result === result)?.value ?? 0;
}

async function overallFailures(): Promise<number> {
  const metric = instrumentationRegistry.getSingleMetric('civitai_app_healthcheck_overall');
  if (!metric) return 0;
  return (await metric.get()).values[0]?.value ?? 0;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const neverProbed = () => -Infinity;
let stopLoop: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  resetHealthCheckReuseForTests();
  resetProbeRunStampForTests();
  mocks.pgDbRead.query.mockImplementation(async () => ({}));
  mocks.pgDbWrite.query.mockImplementation(async () => ({}));
});

afterEach(() => {
  stopLoop?.();
  stopLoop = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function start(options: Parameters<typeof startHealthMetricsLoop>[0]) {
  const handle = startHealthMetricsLoop(options);
  stopLoop = handle?.stop;
  return handle;
}

describe('health metrics loop — runs the shared checks and moves the metrics', () => {
  it('each tick runs every check through runHealthChecks and increments attempts', async () => {
    vi.useFakeTimers();
    const before = await Promise.all(ALL_CHECKS.map((n) => attempts(n, 'success')));

    start({ intervalMs: 15_000, random: () => 0, lastProbeRunStartedAt: neverProbed });
    await vi.advanceTimersByTimeAsync(0);
    const afterOne = await Promise.all(ALL_CHECKS.map((n) => attempts(n, 'success')));
    expect(afterOne.map((v, i) => v - before[i])).toEqual(ALL_CHECKS.map(() => 1));

    await vi.advanceTimersByTimeAsync(15_000);
    const afterTwo = await Promise.all(ALL_CHECKS.map((n) => attempts(n, 'success')));
    expect(afterTwo.map((v, i) => v - before[i])).toEqual(ALL_CHECKS.map(() => 2));
  });

  it('a failing dependency is recorded as a failure attempt and an overall failure', async () => {
    vi.useFakeTimers();
    // Two ticks, two failures; the shared mock's healthy default resumes after.
    dbMock.dbWrite.$transaction
      .mockRejectedValueOnce(new Error('primary down'))
      .mockRejectedValueOnce(new Error('primary down'));
    const failBefore = await attempts('write', 'failure');
    const overallBefore = await overallFailures();

    start({ intervalMs: 15_000, random: () => 0, lastProbeRunStartedAt: neverProbed });
    await vi.advanceTimersByTimeAsync(15_000);

    expect((await attempts('write', 'failure')) - failBefore).toBe(2);
    expect((await overallFailures()) - overallBefore).toBe(2);
  });

  it('its own runs do not stamp the probe clock (so they never suppress a later tick)', async () => {
    vi.useFakeTimers();
    start({ intervalMs: 15_000, random: () => 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(getLastProbeRunStartedAt()).toBe(-Infinity);
    // A probe-path run does stamp it.
    await runHealthChecks(new AbortController().signal);
    expect(getLastProbeRunStartedAt()).toBeGreaterThan(-Infinity);
  });
});

describe('health metrics loop — scheduling', () => {
  it('never overlaps: ticks while a run is in flight are skipped', async () => {
    vi.useFakeTimers();
    let current = deferred();
    const run = vi.fn(() => current.promise);

    vi.stubEnv('HEALTH_METRICS_INTERVAL_MS', '1000');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    start({ random: () => 0, run, lastProbeRunStartedAt: neverProbed });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(run).toHaveBeenCalledTimes(1);

    current.resolve();
    current = deferred();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('is fixed-rate: a slow run does not stretch the period', async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 8_000)));

    start({ intervalMs: 15_000, random: () => 0, run, lastProbeRunStartedAt: neverProbed });
    await vi.advanceTimersByTimeAsync(45_000);
    // Starts at 0, 15s, 30s, 45s — not 0, 23s, 46s.
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('offsets the first run by a random fraction of the interval', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);

    vi.stubEnv('HEALTH_METRICS_INTERVAL_MS', '15000');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    start({ random: () => 0.5, run, lastProbeRunStartedAt: neverProbed });
    await vi.advanceTimersByTimeAsync(7_499);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('skips a tick a probe already covered within the interval, and runs once it has not', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    let clock = 100_000;
    let lastProbe = clock - 5_000;

    vi.stubEnv('HEALTH_METRICS_INTERVAL_MS', '15000');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    start({
      random: () => 0,
      run,
      now: () => clock,
      lastProbeRunStartedAt: () => lastProbe,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();

    // The probe went quiet (readiness no longer runs the checks).
    lastProbe = -Infinity;
    clock += 15_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('health metrics loop — failure isolation', () => {
  it('swallows a rejected or throwing run, logs once per streak at debug, and keeps ticking', async () => {
    vi.useFakeTimers();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const run = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(() => {
        throw new Error('sync boom');
      })
      .mockResolvedValue(undefined);

    start({ intervalMs: 1_000, random: () => 0, run, lastProbeRunStartedAt: neverProbed });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(run).toHaveBeenCalledTimes(3);
    expect(debug).toHaveBeenCalledTimes(1);
  });
});

describe('health metrics loop — off-switch and process lifetime', () => {
  it('parses HEALTH_METRICS_INTERVAL_MS: only a positive number turns it on; everything else is off', () => {
    expect(resolveHealthMetricsIntervalMs('15000')).toBe(15_000);
    expect(resolveHealthMetricsIntervalMs('30000')).toBe(30_000);
    expect(resolveHealthMetricsIntervalMs('0')).toBeNull();
    expect(resolveHealthMetricsIntervalMs('-1')).toBeNull();
    expect(resolveHealthMetricsIntervalMs('soon')).toBeNull();
    expect(resolveHealthMetricsIntervalMs(undefined)).toBeNull();
    expect(resolveHealthMetricsIntervalMs('')).toBeNull();
  });

  it('is DARK by default: with HEALTH_METRICS_INTERVAL_MS unset it starts nothing and never runs', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HEALTH_METRICS_INTERVAL_MS', undefined);
    const run = vi.fn(async () => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(start({ random: () => 0, run, lastProbeRunStartedAt: neverProbed })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('HEALTH_METRICS_INTERVAL_MS=15000 runs it every 15s', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HEALTH_METRICS_INTERVAL_MS', '15000');
    const run = vi.fn(async () => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    start({ random: () => 0, run, lastProbeRunStartedAt: neverProbed });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('HEALTH_METRICS_INTERVAL_MS=0 starts nothing and never runs the checks', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HEALTH_METRICS_INTERVAL_MS', '0');
    const run = vi.fn(async () => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(start({ run, lastProbeRunStartedAt: neverProbed })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('reads the interval from HEALTH_METRICS_INTERVAL_MS when none is passed', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HEALTH_METRICS_INTERVAL_MS', '2000');
    const run = vi.fn(async () => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    start({ random: () => 0, run, lastProbeRunStartedAt: neverProbed });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('both of its timers are unref()d, so it never keeps the process alive', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = vi.fn(async () => undefined);
    const handle = start({
      intervalMs: 60_000,
      random: () => 0.0001,
      run,
      lastProbeRunStartedAt: neverProbed,
    });
    const [startTimer] = handle!.timers();
    expect(startTimer.hasRef()).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(run).toHaveBeenCalledTimes(1);
    const [intervalTimer] = handle!.timers();
    expect(intervalTimer).toBeDefined();
    expect(intervalTimer.hasRef()).toBe(false);
  });

  it('is one loop per process: a second start returns the running loop', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = vi.fn(async () => undefined);
    const first = start({
      intervalMs: 1_000,
      random: () => 0,
      run,
      lastProbeRunStartedAt: neverProbed,
    });
    const second = startHealthMetricsLoop({ intervalMs: 1_000, random: () => 0, run });
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('health metrics loop — readiness never waits on it', () => {
  it('/api/health answers while a loop run is parked on a dependency', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // The loop's pgWrite call parks; every later call (the probe's) answers at once.
    mocks.pgDbWrite.query.mockImplementationOnce(() => new Promise(() => undefined));

    start({ intervalMs: 15_000, random: () => 0, lastProbeRunStartedAt: neverProbed });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.pgDbWrite.query).toHaveBeenCalledTimes(1);

    const res = {
      statusCode: 0,
      body: undefined as unknown,
      on: vi.fn(),
      off: vi.fn(),
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    };
    // No timer is advanced: the probe must complete on its own, with the loop's run still parked.
    await (healthHandler as unknown as (req: unknown, res: unknown) => Promise<unknown>)({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ healthy: true, pgWrite: true });
  });
});

describe('health metrics loop — interval above the timer limit', () => {
  it('a value Node cannot honour as a timer delay turns the loop off instead of hot-looping', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(resolveHealthMetricsIntervalMs('2147483647')).toBe(2_147_483_647);
    expect(resolveHealthMetricsIntervalMs('2147483648')).toBeNull();
    expect(resolveHealthMetricsIntervalMs('1e12')).toBeNull();

    const run = vi.fn(async () => undefined);
    expect(
      start({ intervalMs: 2_147_483_648, run, lastProbeRunStartedAt: neverProbed })
    ).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('health metrics loop — waits for the warm flag, not for runWarmup()', () => {
  it('starts at once when the process is already warm', () => {
    vi.useFakeTimers();
    const startLoop = vi.fn();
    startHealthMetricsLoopWhenWarm(() => true, { start: startLoop });
    expect(startLoop).toHaveBeenCalledTimes(1);
  });

  it('starts on the first poll after the flag flips (e.g. the warmer fail-open timeout)', async () => {
    vi.useFakeTimers();
    const startLoop = vi.fn();
    let warm = false;
    startHealthMetricsLoopWhenWarm(() => warm, { start: startLoop, pollMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(startLoop).not.toHaveBeenCalled();

    warm = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(startLoop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(startLoop).toHaveBeenCalledTimes(1);
  });

  it('starts at the hard cap when the flag never flips', async () => {
    vi.useFakeTimers();
    const startLoop = vi.fn();
    startHealthMetricsLoopWhenWarm(() => false, { start: startLoop, pollMs: 1_000 });
    await vi.advanceTimersByTimeAsync(WARM_MAX_WAIT_MS - 1_000);
    expect(startLoop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(startLoop).toHaveBeenCalledTimes(1);
  });
});

// The contract the alert rules read: every healthcheck family appears exactly ONCE in the
// combined scrape (/api/metrics concatenates the default registry and the shared one; a family
// in both fails the whole scrape), with these names, labels and buckets.
describe('healthcheck metric contract in the combined scrape', () => {
  it('each healthcheck family appears once, with its label names and histogram buckets', async () => {
    await runHealthChecks(new AbortController().signal);
    const scrape = [await client.register.metrics(), await instrumentationRegistry.metrics()].join(
      '\n'
    );
    const families = [...scrape.matchAll(/^# TYPE (civitai_app_healthcheck_\S+) (\S+)$/gm)].map(
      (m) => `${m[1]} ${m[2]}`
    );
    expect(families.sort()).toEqual(
      [
        'civitai_app_healthcheck_attempts_total counter',
        'civitai_app_healthcheck_clickhouse counter',
        'civitai_app_healthcheck_duration_seconds histogram',
        'civitai_app_healthcheck_overall counter',
        'civitai_app_healthcheck_pgread counter',
        'civitai_app_healthcheck_pgwrite counter',
        'civitai_app_healthcheck_read counter',
        'civitai_app_healthcheck_redis counter',
        'civitai_app_healthcheck_sysredis counter',
        'civitai_app_healthcheck_write counter',
      ].sort()
    );

    const attemptsMetric = await instrumentationRegistry
      .getSingleMetric('civitai_app_healthcheck_attempts_total')!
      .get();
    expect(new Set(attemptsMetric.values.flatMap((v) => Object.keys(v.labels)))).toEqual(
      new Set(['name', 'result'])
    );

    const duration = await instrumentationRegistry
      .getSingleMetric('civitai_app_healthcheck_duration_seconds')!
      .get();
    expect(new Set(duration.values.flatMap((v) => Object.keys(v.labels)))).toEqual(
      new Set(['name', 'le'])
    );
    const buckets = duration.values
      .filter((v) => v.metricName?.endsWith('_bucket') && v.labels.name === 'write')
      .map((v) => v.labels.le);
    expect(buckets).toEqual([
      0.001,
      0.005,
      0.01,
      0.025,
      0.05,
      0.1,
      0.25,
      0.5,
      1,
      1.5,
      2,
      2.5,
      3.5,
      5,
      7.5,
      10,
      15,
      20,
      30,
      '+Inf',
    ]);

    const legacy = await instrumentationRegistry
      .getSingleMetric('civitai_app_healthcheck_write')!
      .get();
    expect(legacy.values.every((v) => Object.keys(v.labels).length === 0)).toBe(true);
  });
});

// Production evaluates dependency-checks once per bundler graph: the probes run in the request
// graph, the loop in the instrumentation graph. Two fresh module copies stand in for the two.
describe('health metrics loop — across bundler module graphs', () => {
  it('a probe run in one copy is seen by the other, and both feed the one scraped metric', async () => {
    vi.resetModules();
    const instrumentationGraph = await import('~/server/health/dependency-checks');
    vi.resetModules();
    const requestGraph = await import('~/server/health/dependency-checks');
    expect(requestGraph).not.toBe(instrumentationGraph);

    const before = await attempts('write', 'success');
    await requestGraph.runHealthChecks(new AbortController().signal);
    expect(instrumentationGraph.getLastProbeRunStartedAt()).toBeGreaterThan(-Infinity);

    await instrumentationGraph.runHealthChecks(new AbortController().signal, {
      source: 'metrics-loop',
    });
    expect((await attempts('write', 'success')) - before).toBe(2);
  });
});
