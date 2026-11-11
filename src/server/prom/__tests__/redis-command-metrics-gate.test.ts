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

const { isFliptSync, ensureFliptInitialized } = await import('~/server/flipt/client');
const { armRedisInflightGaugeMode, registerRedisCommandMetricsBatchGate } = await import(
  '~/server/prom/redis-command-metrics-gate'
);
const {
  batchedDurationHistogram,
  batchedInflightGauge,
  getRedisInflightGaugeMode,
  resetRedisInflightGaugeModeForTests,
  setRedisCommandHistogramBatchGate,
} = await import('@civitai/telemetry/redis-command-metrics');

afterEach(() => {
  setRedisCommandHistogramBatchGate(undefined);
  resetRedisInflightGaugeModeForTests();
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

describe('armRedisInflightGaugeMode', () => {
  function probeGauge() {
    const gauge = new client.Gauge({
      name: `gate_gauge_probe_${++n}`,
      help: 'g',
      labelNames: ['client'],
      registers: [new client.Registry()],
    });
    return { gauge, handle: batchedInflightGauge(gauge) };
  }

  it.each([
    [true, 'local', 0],
    [false, 'direct', 1],
    [null, 'direct', 1],
  ])('flag %s at the first command: latches %s (%i per-command inc)', async (flag, mode, incs) => {
    vi.mocked(isFliptSync).mockImplementation((key: string) =>
      key === 'redis-command-metrics-batched' ? flag : null
    );
    await armRedisInflightGaugeMode();
    expect(ensureFliptInitialized).toHaveBeenCalled();
    const { gauge, handle } = probeGauge();
    const inc = vi.spyOn(gauge, 'inc');
    handle.inc({ client: 'cluster' });
    expect(getRedisInflightGaugeMode()).toBe(mode);
    expect(inc).toHaveBeenCalledTimes(incs);
  });

  it('a flag flip after the first command does not change the gauge mode (restart needed)', async () => {
    let flag: boolean | null = true;
    vi.mocked(isFliptSync).mockImplementation((key: string) =>
      key === 'redis-command-metrics-batched' ? flag : null
    );
    await armRedisInflightGaugeMode();
    const { gauge, handle } = probeGauge();
    const inc = vi.spyOn(gauge, 'inc');
    const dec = vi.spyOn(gauge, 'dec');
    handle.inc({ client: 'cluster' });
    flag = false;
    handle.dec({ client: 'cluster' });
    handle.inc({ client: 'cluster' });
    expect(getRedisInflightGaugeMode()).toBe('local');
    expect(inc).not.toHaveBeenCalled();
    expect(dec).not.toHaveBeenCalled();
  });

  it('a Flipt init failure fails open to the per-command path', async () => {
    vi.mocked(ensureFliptInitialized).mockRejectedValueOnce(new Error('flipt down'));
    vi.mocked(isFliptSync).mockReturnValue(null);
    await expect(armRedisInflightGaugeMode()).resolves.toBeUndefined();
    const { gauge, handle } = probeGauge();
    const inc = vi.spyOn(gauge, 'inc');
    handle.inc({ client: 'cluster' });
    expect(getRedisInflightGaugeMode()).toBe('direct');
    expect(inc).toHaveBeenCalledTimes(1);
  });
});
