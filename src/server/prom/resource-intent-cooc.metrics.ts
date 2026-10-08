import client from 'prom-client';
import {
  instrumentationRegistry,
  PROM_PREFIX,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';

export const COOC_RETENTION_HEARTBEAT_METRIC =
  PROM_PREFIX + 'resource_intent_cooc_retention_last_success_timestamp_seconds';
const READ_TTL_MS = 60_000;

/**
 * A gauge whose value is READ from the persisted heartbeat at scrape time (memoized for a minute,
 * so many pods and scrapers cost one tiny keyed read each per minute). It therefore survives pod
 * restarts. With no heartbeat yet, or an unreadable one, the series is absent rather than 0, which
 * the staleness alert's `absent_over_time` arm catches.
 */
export function createCoocRetentionHeartbeatGauge(
  read: () => Promise<Date | null>,
  registry: client.Registry,
  now: () => number = Date.now
) {
  let cached: { at: number; value: Date | null } | null = null;
  return new client.Gauge({
    name: COOC_RETENTION_HEARTBEAT_METRIC,
    help: 'Unix seconds at which the co-occurrence snapshot retention sweep last succeeded (persisted)',
    // Labelled only so that "no heartbeat" scrapes as an absent series: an unlabelled gauge
    // always exports a value, 0 after reset().
    labelNames: ['job'],
    registers: [registry],
    async collect() {
      if (!cached || now() - cached.at >= READ_TTL_MS) {
        try {
          cached = { at: now(), value: await read() };
        } catch {
          cached = { at: now(), value: null };
        }
      }
      this.reset();
      if (cached.value)
        this.set(
          { job: 'resource-intent-cooc-retention' },
          Math.floor(cached.value.getTime() / 1000)
        );
    },
  });
}

registerInstrumentationMetric(COOC_RETENTION_HEARTBEAT_METRIC, () =>
  createCoocRetentionHeartbeatGauge(async () => {
    // Lazy, so importing this module (the metrics route does) does not load the DB graph.
    const [{ dbRead }, { readCoocRetentionHeartbeat }] = await Promise.all([
      import('~/server/db/client'),
      import('~/server/services/resource-intent-cooc/heartbeat'),
    ]);
    return readCoocRetentionHeartbeat(dbRead);
  }, instrumentationRegistry)
);
