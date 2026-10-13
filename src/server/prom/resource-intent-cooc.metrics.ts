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
 * A gauge whose value comes from the persisted heartbeat, so it survives pod restarts. `collect()`
 * never waits on the database: it exports the last value read and starts at most one background
 * refresh once that is older than a minute, so a saturated read pool cannot stall the scrape.
 * With no heartbeat known, the series is absent rather than 0.
 */
export function createCoocRetentionHeartbeatGauge(
  read: () => Promise<Date | null>,
  registry: client.Registry,
  now: () => number = Date.now
) {
  let value: Date | null = null;
  let readAt = -Infinity;
  let inflight: Promise<void> | null = null;
  const refresh = () =>
    (inflight ??= read()
      .then(
        (v) => {
          value = v;
        },
        () => undefined
      )
      .finally(() => {
        readAt = now();
        inflight = null;
      }));
  return {
    refresh,
    gauge: new client.Gauge({
      name: COOC_RETENTION_HEARTBEAT_METRIC,
      help: 'Unix seconds at which the co-occurrence snapshot retention sweep last succeeded (persisted)',
      // Labelled only so that "no heartbeat" scrapes as an absent series: an unlabelled gauge
      // always exports a value, 0 after reset().
      labelNames: ['job'],
      registers: [registry],
      collect() {
        if (now() - readAt >= READ_TTL_MS) void refresh();
        this.reset();
        if (value)
          this.set({ job: 'resource-intent-cooc-retention' }, Math.floor(value.getTime() / 1000));
      },
    }),
  };
}

registerInstrumentationMetric(
  COOC_RETENTION_HEARTBEAT_METRIC,
  () =>
    createCoocRetentionHeartbeatGauge(async () => {
      // Lazy, so importing this module (the metrics route does) does not load the DB graph.
      const [{ dbRead }, { readCoocRetentionHeartbeat }] = await Promise.all([
        import('~/server/db/client'),
        import('~/server/services/resource-intent-cooc/heartbeat'),
      ]);
      return readCoocRetentionHeartbeat(dbRead);
    }, instrumentationRegistry).gauge
);
