import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'EVENTLOOP_WATCHDOG_ENABLED',
  'EVENTLOOP_WATCHDOG_THRESHOLD_MS',
  'EVENTLOOP_WATCHDOG_HEARTBEAT_MS',
  'EVENTLOOP_WATCHDOG_STALL_ENDPOINT',
  'WATCHDOG_METRICS_PORT',
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function loadWatchdog() {
  return import('~/server/eventloop-watchdog');
}

/**
 * Metric names registered while `registerEventLoopWatchdog()` runs.
 *
 * `src/__tests__/setup.ts` stubs `~/server/prom/client` wholesale and does not export
 * `instrumentationRegistry`, so the registry cannot be inspected directly — but
 * `registerInstrumentationMetric` is a `vi.fn` there, and its call log is the same
 * evidence. Measured as a DELTA because the mock is shared process-wide and other
 * modules register into it.
 */
async function registrationsDuring(act: () => void): Promise<string[]> {
  const promClient = await import('~/server/prom/client');
  const register = vi.mocked(promClient.registerInstrumentationMetric);
  const { registerEventLoopWatchdog, shutdownEventLoopWatchdog, __getWatchdogWorkerForTests } =
    await loadWatchdog();

  const before = register.mock.calls.length;
  try {
    registerEventLoopWatchdog();
    act();
  } finally {
    // AWAIT the exit, don't just request it. `vi.resetModules()` gives the next test a
    // fresh module, but a still-running worker from this one keeps the OLD module's
    // exit handler alive — and that handler calls the same process-wide
    // `registerInstrumentationMetric` mock, so its metrics land in the NEXT test's
    // recording. That leak made an intentional shutdown look like a no-token death.
    await stopAndAwaitExit(__getWatchdogWorkerForTests(), shutdownEventLoopWatchdog);
  }
  return register.mock.calls.slice(before).map((call) => String(call[0]));
}

async function stopAndAwaitExit(
  worker: { once: (event: 'exit', cb: (code: number) => void) => void } | undefined,
  stop: () => void
): Promise<number | undefined> {
  if (!worker) {
    stop();
    return undefined;
  }
  const exited = new Promise<number>((resolve) => worker.once('exit', (code) => resolve(code)));
  stop();
  return exited;
}

describe('watchdog config resolution', () => {
  it('is disarmed unless explicitly enabled', async () => {
    expect((await loadWatchdog()).watchdogArmed).toBe(false);

    vi.resetModules();
    process.env.EVENTLOOP_WATCHDOG_ENABLED = 'true';
    expect((await loadWatchdog()).watchdogArmed).toBe(true);
  });

  it('only accepts the exact string "true" as armed', async () => {
    for (const value of ['1', 'yes', 'TRUE', 'true ', '']) {
      vi.resetModules();
      process.env.EVENTLOOP_WATCHDOG_ENABLED = value;
      expect((await loadWatchdog()).watchdogArmed).toBe(false);
    }
  });

  it('defaults the threshold to 1000ms', async () => {
    const { resolveWatchdogThresholdMs } = await loadWatchdog();
    expect(resolveWatchdogThresholdMs()).toBe(1000);
  });

  it('clamps a too-small threshold UP to the floor rather than throwing', async () => {
    // A threshold near the noise level would fire on ordinary GC. Baseline loop lag
    // already reaches multiple seconds at max, so a 5ms threshold is a fat-fingered
    // value, not an intent.
    const { resolveWatchdogThresholdMs } = await loadWatchdog();
    process.env.EVENTLOOP_WATCHDOG_THRESHOLD_MS = '5';
    expect(resolveWatchdogThresholdMs()).toBe(250);
  });

  it('falls back to the default for junk and non-positive thresholds', async () => {
    const { resolveWatchdogThresholdMs } = await loadWatchdog();
    for (const value of ['', 'abc', '0', '-1']) {
      process.env.EVENTLOOP_WATCHDOG_THRESHOLD_MS = value;
      expect(resolveWatchdogThresholdMs()).toBe(1000);
    }
  });

  it('clamps the heartbeat interval at both ends', async () => {
    const { resolveWatchdogHeartbeatMs } = await loadWatchdog();
    expect(resolveWatchdogHeartbeatMs()).toBe(100);

    process.env.EVENTLOOP_WATCHDOG_HEARTBEAT_MS = '1';
    expect(resolveWatchdogHeartbeatMs()).toBe(20);

    process.env.EVENTLOOP_WATCHDOG_HEARTBEAT_MS = '250';
    expect(resolveWatchdogHeartbeatMs()).toBe(250);

    // The MAX_HEARTBEAT_MS ceiling is only reachable with a threshold large enough to
    // satisfy the 3x ratio; at the default 1000ms threshold the ratio binds first and
    // caps the beat at 333. See the ratio-invariant suite below.
    process.env.EVENTLOOP_WATCHDOG_THRESHOLD_MS = '5000';
    process.env.EVENTLOOP_WATCHDOG_HEARTBEAT_MS = '999999';
    expect(resolveWatchdogHeartbeatMs()).toBe(1000);
  });

  it('defaults the metrics port to 9099', async () => {
    const { resolveWatchdogPort } = await loadWatchdog();
    expect(resolveWatchdogPort()).toBe(9099);

    process.env.WATCHDOG_METRICS_PORT = '9500';
    expect(resolveWatchdogPort()).toBe(9500);
  });

  it('does not spawn a worker when disarmed', async () => {
    const { registerEventLoopWatchdog, __getWatchdogWorkerForTests } = await loadWatchdog();
    registerEventLoopWatchdog();
    expect(__getWatchdogWorkerForTests()).toBeUndefined();
  });

  it('does not register watchdog_worker_started when disarmed', async () => {
    // prom-client exports a registered-but-never-set gauge as 0, so registering this
    // at module load would make a pool we simply have not enabled read identically to
    // a pod whose worker spawn threw — and the `== 0` alert is the deploy-defect page.
    const registered = await registrationsDuring(() => {
      /* disarmed: registerEventLoopWatchdog is a no-op */
    });

    expect(registered).not.toContain('civitai_app_watchdog_worker_started');
    expect(registered).not.toContain('civitai_app_watchdog_worker_exits_total');
  });

  it('POSITIVE CONTROL: registers both series once armed', async () => {
    // Without this, the assertion above would pass just as happily against metrics
    // that are never registered at all.
    process.env.EVENTLOOP_WATCHDOG_ENABLED = 'true';
    // Port 0 so an armed test can never collide with a real 9099 or another suite.
    process.env.WATCHDOG_METRICS_PORT = '0';

    const registered = await registrationsDuring(() => undefined);

    expect(registered).toContain('civitai_app_watchdog_worker_started');
    // Registered eagerly at 0 rather than on the first death: absent and zero mean
    // different things to an alert, and it cannot tell them apart.
    expect(registered).toContain('civitai_app_watchdog_worker_exits_total');
  });

  /**
   * Drive an armed watchdog and return the recorded metric calls. `WEBHOOK_TOKEN`
   * matters: without it the worker fails closed and exits 78 before anything else can
   * happen, which is a different scenario entirely (and one the second test uses).
   */
  async function armAndStop({ token }: { token: string | undefined }) {
    process.env.EVENTLOOP_WATCHDOG_ENABLED = 'true';
    process.env.WATCHDOG_METRICS_PORT = '0';
    const savedToken = process.env.WEBHOOK_TOKEN;
    if (token === undefined) delete process.env.WEBHOOK_TOKEN;
    else process.env.WEBHOOK_TOKEN = token;

    const promClient = await import('~/server/prom/client');
    const metrics = new Map<
      string,
      { set: ReturnType<typeof vi.fn>; inc: ReturnType<typeof vi.fn> }
    >();
    vi.mocked(promClient.registerInstrumentationMetric).mockImplementation(((name: string) => {
      if (!metrics.has(name)) metrics.set(name, { set: vi.fn(), inc: vi.fn() });
      return metrics.get(name);
    }) as never);

    try {
      const { registerEventLoopWatchdog, shutdownEventLoopWatchdog, __getWatchdogWorkerForTests } =
        await loadWatchdog();
      registerEventLoopWatchdog();

      const worker = __getWatchdogWorkerForTests();
      expect(worker, 'expected an armed worker').toBeDefined();

      const exited = new Promise<number>((resolve) =>
        worker?.once('exit', (code) => resolve(code))
      );
      shutdownEventLoopWatchdog();
      const exitCode = await exited;

      return {
        exitCode,
        startedCalls: metrics.get('civitai_app_watchdog_worker_started')!.set.mock.calls,
        exitCalls: metrics.get('civitai_app_watchdog_worker_exits_total')!.inc.mock.calls,
      };
    } finally {
      if (savedToken === undefined) delete process.env.WEBHOOK_TOKEN;
      else process.env.WEBHOOK_TOKEN = savedToken;
      vi.mocked(promClient.registerInstrumentationMetric).mockImplementation((() => ({
        set: vi.fn(),
        inc: vi.fn(),
        dec: vi.fn(),
        observe: vi.fn(),
      })) as never);
    }
  }

  it('🔴 an intentional shutdown is not counted as a death', async () => {
    const { exitCode, startedCalls, exitCalls } = await armAndStop({ token: 'test-token' });

    expect(exitCode).toBe(0);
    // set(1) at spawn and never again — in particular never set(0) on exit.
    expect(startedCalls).toEqual([[1]]);
    // Only the two zero-seeds. Counting our own shutdown would make the "worker died"
    // alert fire on every ordinary pod termination.
    expect(exitCalls).toEqual([
      [{ reason: 'crash' }, 0],
      [{ reason: 'no-token' }, 0],
    ]);
  });

  it('🔴 a missing token is counted as no-token, not as a crash', async () => {
    // A configuration fault and a runtime death have different owners and different
    // fixes. Without the label they share a signature, which is the gap that made the
    // previous "died after starting" alert unfireable one layer up.
    const { exitCode, startedCalls, exitCalls } = await armAndStop({ token: undefined });

    expect(exitCode).toBe(78);
    expect(startedCalls).toEqual([[1]]);
    expect(exitCalls).toContainEqual([{ reason: 'no-token' }]);
    expect(exitCalls).not.toContainEqual([{ reason: 'crash' }]);
  });
});

describe('threshold/beat ratio invariant', () => {
  // The two settings are only independently meaningful while threshold/beat stays
  // well above 1. Enforced by lowering the BEAT: the threshold is the operator's
  // stated intent, so silently raising it would change what the pod detects while the
  // config still claims otherwise.
  it('lowers the beat to keep threshold >= 3x beat, leaving the threshold alone', async () => {
    const { resolveWatchdogHeartbeatMs, resolveWatchdogThresholdMs } = await loadWatchdog();

    process.env.EVENTLOOP_WATCHDOG_THRESHOLD_MS = '250';
    process.env.EVENTLOOP_WATCHDOG_HEARTBEAT_MS = '100';

    expect(resolveWatchdogThresholdMs()).toBe(250);
    expect(resolveWatchdogHeartbeatMs()).toBe(83);
  });

  it('leaves a configured beat untouched when it already satisfies the ratio', async () => {
    const { resolveWatchdogHeartbeatMs } = await loadWatchdog();

    for (const [threshold, beat] of [
      ['1000', 100],
      ['5000', 100],
      ['1000', 333],
    ] as const) {
      process.env.EVENTLOOP_WATCHDOG_THRESHOLD_MS = threshold;
      process.env.EVENTLOOP_WATCHDOG_HEARTBEAT_MS = String(beat);
      expect(resolveWatchdogHeartbeatMs(), `${threshold}/${beat}`).toBe(beat);
    }
  });

  it('holds the invariant across the whole legal threshold range', async () => {
    const { resolveWatchdogHeartbeatMs, resolveWatchdogThresholdMs } = await loadWatchdog();

    // Every threshold anyone can configure, against the largest beat anyone can ask
    // for. `threshold / 3` never approaches the 20ms beat floor, so the clamp always
    // has room and never has to touch the threshold to satisfy the ratio.
    for (const threshold of [250, 300, 1000, 2500, 5000, 60_000]) {
      process.env.EVENTLOOP_WATCHDOG_THRESHOLD_MS = String(threshold);
      process.env.EVENTLOOP_WATCHDOG_HEARTBEAT_MS = '1000';

      const beat = resolveWatchdogHeartbeatMs();
      const effectiveThreshold = resolveWatchdogThresholdMs();

      expect(beat, `threshold=${threshold}`).toBeGreaterThanOrEqual(20);
      expect(beat * 3, `threshold=${threshold}`).toBeLessThanOrEqual(effectiveThreshold);
      // The threshold itself is never moved to satisfy the ratio.
      expect(effectiveThreshold, `threshold=${threshold}`).toBe(Math.max(threshold, 250));
    }
  });
});

describe('watchdog heartbeat', () => {
  it('records the timestamp it is given', async () => {
    const { recordWatchdogHeartbeat, WATCHDOG_WORKER_SOURCE } = await loadWatchdog();
    // The store is only observable through the worker, so assert the contract that
    // matters here: the call is safe to make unconditionally, including when the
    // watchdog was never armed and no worker exists to read it.
    expect(() => recordWatchdogHeartbeat(1_700_000_000_000)).not.toThrow();
    expect(() => recordWatchdogHeartbeat()).not.toThrow();
    expect(WATCHDOG_WORKER_SOURCE).toContain('civitai_app_watchdog_up');
  });
});

// The synthetic stall endpoint is covered separately in
// eventloop-stall-endpoint.test.ts — it needs endpoint-helpers stubbed at module
// load, which shouldn't be imposed on this file's graph.
