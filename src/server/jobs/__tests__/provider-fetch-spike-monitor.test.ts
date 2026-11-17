import client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({
  ch: { $query: vi.fn() } as { $query: ReturnType<typeof vi.fn> } | undefined,
}));

vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return holder.ch;
  },
}));

vi.mock('../job', () => ({
  createJob: (_name: string, _cron: string, fn: (ctx: unknown) => Promise<unknown>) => ({
    run: fn,
  }),
}));

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { providerFetchSpikeMonitorJob } from '../provider-fetch-spike-monitor';

const chQuery = vi.fn();
type Result = { providers?: number; spikes?: string[]; skipped?: string };
const run = () =>
  (providerFetchSpikeMonitorJob as unknown as { run: (ctx: unknown) => Promise<Result> }).run({});

const HOUR = 3600;
// 2026-11-10T06:05Z, when the hourly run fires: the hour it judges is 05:00-06:00.
const NOW = Date.UTC(2026, 10, 10, 6, 5) / 1000;
const HOUR_END = Date.UTC(2026, 10, 10, 6) / 1000;
const CURRENT = HOUR_END - HOUR;

/** `perHour` distinct versions in each of the 168 hours before the judged one, then `current`. */
const week = (provider: string, perHour: number, current: number) => [
  ...Array.from({ length: 168 }, (_, i) => ({
    provider,
    hour: String(CURRENT - (i + 1) * HOUR),
    versions: String(perHour),
  })),
  ...(current ? [{ provider, hour: String(CURRENT), versions: String(current) }] : []),
];

const gauge = async (name: string, provider: string) => {
  const metric = client.register.getSingleMetric(`civitai_app_${name}`);
  if (!metric) throw new Error(`gauge civitai_app_${name} is not registered`);
  const { values } = await (
    metric as unknown as {
      get: () => Promise<{ values: { value: number; labels: { provider?: string } }[] }>;
    }
  ).get();
  return values.find((v) => v.labels.provider === provider)?.value;
};
const lastRun = async () => {
  const metric = client.register.getSingleMetric(
    'civitai_app_provider_fetch_spike_monitor_last_run_timestamp_seconds'
  );
  return (
    await (metric as unknown as { get: () => Promise<{ values: { value: number }[] }> }).get()
  ).values[0]?.value;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW * 1000, toFake: ['Date'] });
  holder.ch = { $query: chQuery };
});
afterEach(() => vi.useRealTimers());

describe('provider-fetch-spike-monitor', () => {
  it('flags a provider whose hour is over three times its baseline and the floor', async () => {
    chQuery.mockResolvedValue([...week('alpha', 10, 31), ...week('beta', 10, 30)]);
    expect(await run()).toEqual({ providers: 2, spikes: ['alpha'] });
    expect(await gauge('provider_fetch_distinct_versions', 'alpha')).toBe(31);
    expect(await gauge('provider_fetch_distinct_versions_baseline', 'alpha')).toBe(10);
    expect(await gauge('provider_fetch_spike', 'alpha')).toBe(1);
    // Control: exactly three times the baseline is not a spike.
    expect(await gauge('provider_fetch_spike', 'beta')).toBe(0);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'provider-fetch-spike' })
    );
  });

  it('does not flag a new provider under the floor, however far over its zero baseline', async () => {
    chQuery.mockResolvedValue([{ provider: 'new', hour: String(CURRENT), versions: '24' }]);
    expect(await run()).toEqual({ providers: 1, spikes: [] });
    expect(await gauge('provider_fetch_distinct_versions_baseline', 'new')).toBe(0);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('flags a new provider at the floor', async () => {
    chQuery.mockResolvedValue([{ provider: 'new', hour: String(CURRENT), versions: '25' }]);
    expect(await run()).toEqual({ providers: 1, spikes: ['new'] });
  });

  it('counts empty hours as zero, so a few busy hours do not set the baseline', async () => {
    // 8 busy hours out of 168 are under 5%: the p95 is an empty hour.
    const busy = Array.from({ length: 8 }, (_, i) => ({
      provider: 'alpha',
      hour: String(CURRENT - (i + 1) * HOUR),
      versions: '100',
    }));
    chQuery.mockResolvedValue([
      ...busy,
      { provider: 'alpha', hour: String(CURRENT), versions: '30' },
    ]);
    expect(await run()).toEqual({ providers: 1, spikes: ['alpha'] });
    expect(await gauge('provider_fetch_distinct_versions_baseline', 'alpha')).toBe(0);
  });

  it('reads only the judged hour and the week before it, bounding time first', async () => {
    chQuery.mockResolvedValue([]);
    await run();
    const [strings, ...values] = chQuery.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(values).toEqual([HOUR_END - 169 * HOUR, HOUR_END]);
    expect(strings.join('?')).toMatch(/WHERE time >= toDateTime\(\?\) AND time < toDateTime\(\?\)/);
  });

  it('drops a provider absent from this run rather than keeping its last value', async () => {
    chQuery.mockResolvedValue(week('gone', 10, 40));
    await run();
    expect(await gauge('provider_fetch_spike', 'gone')).toBe(1);
    chQuery.mockResolvedValue([]);
    await run();
    expect(await gauge('provider_fetch_spike', 'gone')).toBeUndefined();
  });

  it('publishes nothing without ClickHouse, leaving the last-run anchor stale', async () => {
    chQuery.mockResolvedValue([]);
    await run();
    const before = await lastRun();
    expect(before).toBe(NOW);
    vi.setSystemTime((NOW + HOUR) * 1000);
    holder.ch = undefined;
    expect(await run()).toEqual({ skipped: 'clickhouse-unavailable' });
    expect(await lastRun()).toBe(before);
  });
});
