import client from 'prom-client';
import {
  instrumentationRegistry,
  PROM_PREFIX,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import { cachedRead } from './cached-read';

/**
 * Metrics of the resource-intent v1 tag index: the per-pod holder (what it holds and how its loads
 * went), and the weekly job's persisted heartbeats and the newest ready snapshot, read from the
 * database so every pod exports the same values and they survive restarts.
 *
 * This module is a prom-client leaf: the metrics route imports it, and the database and Flipt are
 * imported lazily, inside the reads. The holder reports into it (`recordTagIndexLoad`,
 * `setHeldTagIndex`); what it holds is pinned on globalThis, because a second webpack graph gets the
 * first graph's gauge back from `registerInstrumentationMetric`, collect() and all.
 */

const M = PROM_PREFIX + 'resource_intent_tag_index_';
export const TAG_INDEX_METRICS = {
  loads: M + 'loads_total',
  loadDuration: M + 'load_duration_seconds',
  snapshotAge: M + 'snapshot_age_seconds',
  snapshotInfo: M + 'snapshot_info',
  buildLastSuccess: M + 'build_last_success_timestamp_seconds',
  retentionLastSuccess: M + 'retention_last_success_timestamp_seconds',
  newestReadyCreated: M + 'newest_ready_created_timestamp_seconds',
} as const;

/** How a holder load ended: loaded, or the holder's fallback reason for the failure. */
export type TagIndexLoadOutcome = 'success' | 'load_failed' | 'snapshot_unservable';
const LOAD_OUTCOMES: readonly TagIndexLoadOutcome[] = [
  'success',
  'load_failed',
  'snapshot_unservable',
];

/** What a pod holds, as its metrics name it. */
export type HeldTagIndex = {
  id: string;
  payloadSha256: string;
  specHash: string;
  vocabVersion: string;
  createdAt: Date;
};

declare global {
  // eslint-disable-next-line no-var
  var __civitaiTagIndexHeld: { held: HeldTagIndex | null } | undefined;
}
const state = (globalThis.__civitaiTagIndexHeld ??= { held: null });

const short = (hex: string) => hex.slice(0, 12);

const loads = registerInstrumentationMetric(TAG_INDEX_METRICS.loads, () => {
  const c = new client.Counter({
    name: TAG_INDEX_METRICS.loads,
    help: 'Tag-index snapshot checks on this pod that loaded a snapshot (success) or failed, by the holder fallback reason the failure gives (load_failed: retried in a minute; snapshot_unservable: refused until a different snapshot is newest). A check that finds the held snapshot still newest counts nothing.',
    labelNames: ['outcome'],
    registers: [instrumentationRegistry],
  });
  for (const outcome of LOAD_OUTCOMES) c.inc({ outcome }, 0);
  return c;
});

const loadDuration = registerInstrumentationMetric(
  TAG_INDEX_METRICS.loadDuration,
  () =>
    new client.Histogram({
      name: TAG_INDEX_METRICS.loadDuration,
      help: 'Wall time of a tag-index snapshot load on this pod (download, verify, decode on a worker thread, assemble), by outcome. A check that loads nothing (the held snapshot is still newest, or the manifest read failed) is not observed; a check abandoned at the 2-minute timeout is observed as load_failed at the time it was abandoned.',
      labelNames: ['outcome'],
      buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
      registers: [instrumentationRegistry],
    })
);

registerInstrumentationMetric(
  TAG_INDEX_METRICS.snapshotAge,
  () =>
    new client.Gauge({
      name: TAG_INDEX_METRICS.snapshotAge,
      help: 'Seconds since the tag-index snapshot this pod holds was built (its manifest createdAt). Absent when the pod holds none: the holder flag is off, nothing has asked for it, or no load has succeeded.',
      labelNames: ['snapshot_id'],
      registers: [instrumentationRegistry],
      collect() {
        this.reset();
        const held = state.held;
        if (held)
          this.set(
            { snapshot_id: held.id },
            Math.max(0, (Date.now() - held.createdAt.getTime()) / 1000)
          );
      },
    })
);

registerInstrumentationMetric(
  TAG_INDEX_METRICS.snapshotInfo,
  () =>
    new client.Gauge({
      name: TAG_INDEX_METRICS.snapshotInfo,
      help: 'The tag-index snapshot this pod holds, as labels (hashes are 12-hex-digit prefixes); value 1. Absent when it holds none.',
      labelNames: ['snapshot_id', 'payload_sha256', 'spec_hash', 'vocab_version'],
      registers: [instrumentationRegistry],
      collect() {
        this.reset();
        const held = state.held;
        if (held)
          this.set(
            {
              snapshot_id: held.id,
              payload_sha256: short(held.payloadSha256),
              spec_hash: short(held.specHash),
              vocab_version: short(held.vocabVersion),
            },
            1
          );
      },
    })
);

/** The holder's report of one load. */
export function recordTagIndexLoad(outcome: TagIndexLoadOutcome, seconds: number | null) {
  loads.inc({ outcome });
  if (seconds !== null) loadDuration.observe({ outcome }, seconds);
}

/** The holder's report of what it now holds (null: nothing). */
export function setHeldTagIndex(held: HeldTagIndex | null) {
  state.held = held;
}

type Heartbeats = Record<'buildSuccess' | 'retentionSuccess', Date | null>;

/**
 * The job's two persisted heartbeats, from one cached KeyValue read: last build success and last
 * retention success. Each is absent until its first write, and both are absent (and nothing is
 * read) while `enabled` (the build flag) reads false, so a pod with every flag off does no I/O for
 * them.
 */
export function createTagIndexHeartbeatGauges(
  read: () => Promise<Heartbeats>,
  enabled: () => Promise<boolean>,
  registry: client.Registry,
  now: () => number = Date.now
) {
  const heartbeats = cachedRead(async () => ((await enabled()) ? read() : null), 60_000, now);
  const gauge = (
    name: string,
    help: string,
    which: keyof Heartbeats,
    job: string
  ): client.Gauge<string> =>
    new client.Gauge({
      name,
      help,
      // Labelled only so that "no heartbeat" scrapes as an absent series.
      labelNames: ['job'],
      registers: [registry],
      collect() {
        const value = heartbeats.current()?.[which];
        this.reset();
        if (value) this.set({ job }, Math.floor(value.getTime() / 1000));
      },
    });
  return {
    refresh: heartbeats.refresh,
    gauges: [
      gauge(
        TAG_INDEX_METRICS.buildLastSuccess,
        'Unix seconds at which the weekly tag-index build last stored a snapshot (persisted)',
        'buildSuccess',
        'build-resource-intent-tag-index'
      ),
      gauge(
        TAG_INDEX_METRICS.retentionLastSuccess,
        'Unix seconds at which tag-index snapshot retention (run by the weekly build job) last succeeded (persisted)',
        'retentionSuccess',
        'resource-intent-tag-index-retention'
      ),
    ],
  };
}

/**
 * The newest ready snapshot's createdAt per spec hash (12-hex-digit prefix), from a cached read.
 * Absent when there is none, and while `enabled` (the build flag) reads false, so pods do not query
 * a table that may not exist yet.
 */
export function createNewestReadyGauge(
  read: () => Promise<{ specHash: string; createdAt: Date }[]>,
  enabled: () => Promise<boolean>,
  registry: client.Registry,
  now: () => number = Date.now
) {
  const newest = cachedRead(async () => ((await enabled()) ? read() : []), 60_000, now);
  return {
    refresh: newest.refresh,
    gauge: new client.Gauge({
      name: TAG_INDEX_METRICS.newestReadyCreated,
      help: 'Unix seconds of the newest ready ResourceIntentTagIndexSnapshot row (its createdAt, the database clock), per spec hash. Absent while the build flag is off or no row is ready.',
      labelNames: ['spec_hash'],
      registers: [registry],
      collect() {
        const rows = newest.current() ?? [];
        this.reset();
        for (const r of rows)
          this.set({ spec_hash: short(r.specHash) }, Math.floor(r.createdAt.getTime() / 1000));
      },
    }),
  };
}

/** Whether the build flag is on: both database-reading gauges read nothing while it is off. */
const buildFlagOn = async () => {
  const { FLIPT_FEATURE_FLAGS, isFlipt } = await import('~/server/flipt/client');
  return isFlipt(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_TAG_INDEX_BUILD);
};

/**
 * Test/wait support: each database-reading gauge's `refresh` (see cachedRead), by metric name.
 * Stored only, never called here, so it starts no read. Filled when this module graph creates the
 * gauges; a graph that got another graph's gauges back has none.
 */
const gaugeRefresh = new Map<string, () => Promise<void>>();

/**
 * Test/wait support: resolves when the named database-reading gauge's read has finished. Returns
 * the read in flight (as a scrape starts one), or starts one if none is.
 */
export function waitForTagIndexGaugeRead(name: string): Promise<void> {
  const refresh = gaugeRefresh.get(name);
  if (!refresh) throw new Error(`no database-reading tag-index gauge ${name} in this module graph`);
  return refresh();
}

// Keyed on the first of the two gauges: a second graph finds it and creates neither.
registerInstrumentationMetric(TAG_INDEX_METRICS.buildLastSuccess, () => {
  const { gauges, refresh } = createTagIndexHeartbeatGauges(
    async () => {
      // Lazy, so importing this module (the metrics route does) does not load the DB graph.
      const [{ dbRead }, { readTagIndexHeartbeats }] = await Promise.all([
        import('~/server/db/client'),
        import('~/server/services/resource-intent-tags/heartbeat'),
      ]);
      return readTagIndexHeartbeats(dbRead);
    },
    buildFlagOn,
    instrumentationRegistry
  );
  gaugeRefresh.set(TAG_INDEX_METRICS.buildLastSuccess, refresh);
  gaugeRefresh.set(TAG_INDEX_METRICS.retentionLastSuccess, refresh);
  return gauges[0];
});

registerInstrumentationMetric(TAG_INDEX_METRICS.newestReadyCreated, () => {
  const { gauge, refresh } = createNewestReadyGauge(
    async () => {
      const [{ dbRead }, { readNewestReadyCreatedAt }, { coocSqlOf }] = await Promise.all([
        import('~/server/db/client'),
        import('~/server/services/resource-intent-tags/heartbeat'),
        import('~/server/services/resource-intent-cooc/store'),
      ]);
      return readNewestReadyCreatedAt(coocSqlOf(dbRead));
    },
    buildFlagOn,
    instrumentationRegistry
  );
  gaugeRefresh.set(TAG_INDEX_METRICS.newestReadyCreated, refresh);
  return gauge;
});
