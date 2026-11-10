import client from 'prom-client';
import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { PROM_PREFIX } from '~/server/prom/client';
import { createJob } from './job';

const HOUR_S = 60 * 60;
const BASELINE_HOURS = 7 * 24;
/** A spike needs at least this many distinct versions in the hour, so a new provider (baseline 0) does not fire on a few fetches. */
export const SPIKE_FLOOR = 25;
/** ...and more than this multiple of its baseline. */
export const SPIKE_MULTIPLIER = 3;

type HourRow = { provider: string; hour: number | string; versions: number | string };

export type ProviderObservation = {
  provider: string;
  current: number;
  baseline: number;
  spike: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var providerFetchSpikeGauges:
    | Record<'current' | 'baseline' | 'spike' | 'lastRun', client.Gauge<string>>
    | undefined;
}

const gauges = (global.providerFetchSpikeGauges ??= {
  current: new client.Gauge({
    name: `${PROM_PREFIX}provider_fetch_distinct_versions`,
    help: 'Distinct model versions a provider fetched with its download token in the last complete hour.',
    labelNames: ['provider'],
  }),
  baseline: new client.Gauge({
    name: `${PROM_PREFIX}provider_fetch_distinct_versions_baseline`,
    help: "p95 of the provider's hourly distinct versions over the prior 7 days, empty hours counted as 0.",
    labelNames: ['provider'],
  }),
  spike: new client.Gauge({
    name: `${PROM_PREFIX}provider_fetch_spike`,
    help: 'Whether the last complete hour is a spike over the baseline (1) or not (0).',
    labelNames: ['provider'],
  }),
  lastRun: new client.Gauge({
    name: `${PROM_PREFIX}provider_fetch_spike_monitor_last_run_timestamp_seconds`,
    help: 'When the monitor last completed a run. Stale means every provider gauge is stale.',
  }),
});

/**
 * Hourly distinct versions per provider, for the hour ending at `hourEnd` and the 168 before it.
 * `time` leads the table's sort key, so bounding it first limits the read to the last week.
 */
async function fetchHourRows(hourEnd: number) {
  if (!clickhouse) return undefined;
  const start = hourEnd - (BASELINE_HOURS + 1) * HOUR_S;
  return clickhouse.$query<HourRow>`
    SELECT provider, toUnixTimestamp(toStartOfHour(time)) AS hour, uniqExact(modelVersionId) AS versions
    FROM default.modelVersionEvents
    WHERE time >= toDateTime(${start}) AND time < toDateTime(${hourEnd})
      AND type = 'GenerationFetch' AND provider != ''
    GROUP BY provider, hour
  `;
}

const p95 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
};

export function observe(rows: HourRow[], hourEnd: number): ProviderObservation[] {
  const currentHour = hourEnd - HOUR_S;
  const byProvider = new Map<string, Map<number, number>>();
  for (const row of rows) {
    const hours = byProvider.get(row.provider) ?? new Map<number, number>();
    hours.set(Number(row.hour), Number(row.versions));
    byProvider.set(row.provider, hours);
  }
  return [...byProvider].map(([provider, hours]) => {
    const current = hours.get(currentHour) ?? 0;
    const prior = Array.from(
      { length: BASELINE_HOURS },
      (_, i) => hours.get(currentHour - (i + 1) * HOUR_S) ?? 0
    );
    const baseline = p95(prior);
    return {
      provider,
      current,
      baseline,
      spike: current >= SPIKE_FLOOR && current > SPIKE_MULTIPLIER * baseline,
    };
  });
}

export const providerFetchSpikeMonitorJob = createJob(
  'provider-fetch-spike-monitor',
  '5 * * * *',
  async () => {
    const hourEnd = Math.floor(Date.now() / 1000 / HOUR_S) * HOUR_S;
    const rows = await fetchHourRows(hourEnd);
    // No ClickHouse configured: publish nothing, and leave the anchor stale.
    if (!rows) return { skipped: 'clickhouse-unavailable' };

    const observations = observe(rows, hourEnd);
    // A provider absent this run drops its series rather than keeping a stale value.
    gauges.current.reset();
    gauges.baseline.reset();
    gauges.spike.reset();
    for (const { provider, current, baseline, spike } of observations) {
      gauges.current.set({ provider }, current);
      gauges.baseline.set({ provider }, baseline);
      gauges.spike.set({ provider }, spike ? 1 : 0);
    }
    gauges.lastRun.set(Date.now() / 1000);

    const spikes = observations.filter((o) => o.spike);
    if (spikes.length > 0) {
      await logToAxiom({
        type: 'error',
        name: 'provider-fetch-spike',
        message: `distinct versions fetched spiked for: ${spikes
          .map((o) => o.provider)
          .join(', ')}`,
        spikes: JSON.stringify(spikes),
      }).catch(() => undefined);
    }

    return { providers: observations.length, spikes: spikes.map((o) => o.provider) };
  }
);
