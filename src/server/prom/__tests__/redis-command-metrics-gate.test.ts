import client from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The boot-time gate behind the batched `redis_command_duration_seconds` handle reads the
 * `redis-command-metrics-batched` Flipt flag with no entity: on, observes are accumulated (none
 * reaches prom-client per command); off or unknown, every observe reaches prom-client as before.
 */

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
  getFliptClientSync: vi.fn(() => ({})),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

const { isFliptSync } = await import('~/server/flipt/client');
const { registerRedisCommandMetricsBatchGate } = await import(
  '~/server/prom/redis-command-metrics-gate'
);
const { batchedDurationHistogram, setRedisCommandHistogramBatchGate } = await import(
  '@civitai/telemetry/redis-command-metrics'
);

afterEach(() => {
  setRedisCommandHistogramBatchGate(undefined);
  vi.restoreAllMocks();
});

let n = 0;
function probeHistogram() {
  const histogram = new client.Histogram({
    name: `gate_probe_${++n}`,
    help: 'h',
    labelNames: ['client'],
    buckets: [1],
    registers: [new client.Registry()],
  });
  return { histogram, handle: batchedDurationHistogram(histogram, [1]) };
}

describe('registerRedisCommandMetricsBatchGate', () => {
  it.each([
    [true, 0],
    [false, 1],
    [null, 1],
  ])('flag %s: %i per-command prom-client observe(s)', (flag, expectedObserves) => {
    vi.mocked(isFliptSync).mockImplementation((key: string) =>
      key === 'redis-command-metrics-batched' ? flag : null
    );
    registerRedisCommandMetricsBatchGate();
    const { histogram, handle } = probeHistogram();
    const observe = vi.spyOn(histogram, 'observe');
    handle.observe({ client: 'cluster' }, 0.5);
    expect(observe).toHaveBeenCalledTimes(expectedObserves);
    expect(vi.mocked(isFliptSync).mock.calls).toContainEqual(['redis-command-metrics-batched']);
  });
});
