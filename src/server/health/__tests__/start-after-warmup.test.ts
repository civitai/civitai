import type client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The boot sequence instrumentation.node.ts runs: kick the warmer, then start the dependency-health
// metrics loop once the pod is warm. What it must hold: the loop is gated on the REAL warm flag
// (warmup.isWarm, which also flips on the warmer's fail-open timeout), never on runWarmup()
// resolving (a hung warm request can keep that pending forever), and never on "always warm".

// warmup.ts imports instrumentationRegistry, which the global prom mock does not export (same
// override as readyz-endpoint.test.ts).
const { testRegistry } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const promClient = require('prom-client');
  return { testRegistry: new promClient.Registry() as client.Registry };
});
vi.mock('~/server/prom/client', () => ({
  instrumentationRegistry: testRegistry,
  registerInstrumentationMetric: <M extends client.Metric<string>>(name: string, f: () => M): M =>
    (testRegistry.getSingleMetric(name) as unknown as M) ?? f(),
}));

import { startWarmupAndHealthMetricsLoop } from '~/server/health/start-after-warmup';
import { isWarm } from '~/server/warmup';

const never = () => new Promise<void>(() => undefined);

/** A metrics-loop module that records the warm predicate it was started with. */
function fakeLoop() {
  const calls: Array<() => boolean> = [];
  return {
    calls,
    module: Promise.resolve({
      startHealthMetricsLoopWhenWarm: (predicate: () => boolean) => void calls.push(predicate),
    }),
  };
}

beforeEach(() => {
  globalThis.__civitaiWarmState!.ready = false;
  globalThis.__civitaiWarmState!.state = 'in-progress';
});
afterEach(() => {
  globalThis.__civitaiWarmState!.ready = false;
});

describe('startWarmupAndHealthMetricsLoop', () => {
  it('kicks the warmer and gates the loop on the real warm flag while runWarmup() is still pending', async () => {
    const loop = fakeLoop();
    const runWarmup = vi.fn(never); // a hung warm request: runWarmup() never resolves
    await startWarmupAndHealthMetricsLoop({
      warmup: Promise.resolve({ runWarmup, isWarm }),
      metricsLoop: loop.module,
      logError: () => undefined,
    });

    expect(runWarmup).toHaveBeenCalledTimes(1);
    // Handed to the loop although runWarmup() has not resolved...
    expect(loop.calls).toHaveLength(1);
    const predicate = loop.calls[0];
    // ...and it is the warm flag: false while cold, true once the shared warm state flips (as the
    // warmer's fail-open timeout does).
    expect(predicate()).toBe(false);
    globalThis.__civitaiWarmState!.ready = true;
    expect(predicate()).toBe(true);
  });

  it('starts the loop at once when the warmer module fails to load', async () => {
    const loop = fakeLoop();
    const errors: string[] = [];
    const warmup = Promise.reject(new Error('import failed'));
    await startWarmupAndHealthMetricsLoop({
      warmup,
      metricsLoop: loop.module,
      logError: (message) => errors.push(message),
    });
    await Promise.resolve();

    expect(loop.calls).toHaveLength(1);
    expect(loop.calls[0]()).toBe(true); // cold flag, yet the loop is not held back
    expect(errors.some((m) => m.includes('warmup kick failed'))).toBe(true);
  });

  it('never rejects when the metrics-loop module fails to load', async () => {
    const errors: string[] = [];
    await expect(
      startWarmupAndHealthMetricsLoop({
        warmup: Promise.resolve({ runWarmup: never, isWarm }),
        metricsLoop: Promise.reject(new Error('import failed')),
        logError: (message) => errors.push(message),
      })
    ).resolves.toBeUndefined();
    expect(errors.some((m) => m.includes('health metrics loop start failed'))).toBe(true);
  });
});
