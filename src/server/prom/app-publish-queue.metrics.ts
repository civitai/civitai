// App publish REVIEW QUEUE gauges — how many publish requests are waiting for a moderator, and how
// long the oldest has waited, for app versions (`app_block_publish_requests`) and store listings
// (`app_listing_publish_requests`).
//
// WHY: a queue with no reviewer looks exactly like a queue with nothing in it unless something
// measures the wait. Nothing did, so a 44-hour stretch with zero reviews went unnoticed. Alert on
// `civitai_app_publish_queue_oldest_pending_seconds`, not on the count: one request waiting two
// days is the incident; ten requests submitted a minute ago are not.
//
// HOW IT STAYS OFF THE HOT PATH (the challenge-gauge pattern, ~/server/prom/challenge.metrics.ts):
// the gauges are collect()-based, a scrape only ever kicks a background refresh and serves the last
// good snapshot, one memoized read (TTL below) serves every scraper on the pod, and the read runs
// on the replica under a statement_timeout. Both counts are index-only on each table's
// `(status, submitted_at)` queue index. The snapshot stores the oldest SUBMIT TIME, not an age, so
// the age keeps growing between refreshes rather than freezing at the last read.
//
// PER POD: every web pod runs its own read and exports its own copy, so aggregate with `max()`
// (never `sum()`, which multiplies the count by the pod count).
//
// NO DATA UNTIL THE FIRST GOOD READ, ON PURPOSE. Before a read succeeds there is nothing true to
// report, and a zero would read as "queue empty" — the exact silence this exists to end. After
// that, both kinds are always emitted (a `GROUP BY` returns no row for an empty queue, so the
// query is two aggregates that always return a row).
//
// NO DATA AFTER A STALE READ, FOR THE SAME REASON. If reads keep failing, the last good snapshot
// is served for at most `APP_PUBLISH_QUEUE_MAX_STALENESS_MS`, then the series disappear. Serving
// it forever would freeze the pending count (a queue that kept growing reads as unchanged), and an
// absent series is what an alert on "no data" can catch.
//
// prom-client GOTCHA: Next.js can load this module twice and prom-client throws on a duplicate
// name, so registration is a get-or-create guard on the default registry, like every module here.
import client, { type Registry } from 'prom-client';

export const APP_PUBLISH_QUEUE_KINDS = ['block', 'listing'] as const;
export type AppPublishQueueKind = (typeof APP_PUBLISH_QUEUE_KINDS)[number];

export const APP_PUBLISH_QUEUE_OLDEST_SECONDS = 'civitai_app_publish_queue_oldest_pending_seconds';
export const APP_PUBLISH_QUEUE_PENDING_COUNT = 'civitai_app_publish_queue_pending_count';

const APP_PUBLISH_QUEUE_TTL_MS = 60_000;
const APP_PUBLISH_QUEUE_STATEMENT_TIMEOUT_MS = 5_000;
/** How long the last good snapshot may be served while reads are failing. Ten refresh periods. */
export const APP_PUBLISH_QUEUE_MAX_STALENESS_MS = 10 * 60_000;

/** One row of the queue read. `oldest` is null when nothing is pending. */
export type AppPublishQueueRow = {
  kind: string;
  pending: number | string;
  oldest: Date | string | null;
};

export type AppPublishQueueGaugeValues = Record<
  AppPublishQueueKind,
  { pending: number; oldestPendingSeconds: number }
>;

/**
 * The gauge values for a snapshot at `nowMs`. Every kind is present: a kind missing from the rows,
 * or with nothing pending, is 0/0. A non-finite or future timestamp yields an age of 0, never a
 * negative or NaN gauge.
 */
export function computeAppPublishQueueGauges(
  rows: readonly AppPublishQueueRow[],
  nowMs: number
): AppPublishQueueGaugeValues {
  const out = {} as AppPublishQueueGaugeValues;
  for (const kind of APP_PUBLISH_QUEUE_KINDS) out[kind] = { pending: 0, oldestPendingSeconds: 0 };
  for (const row of rows) {
    if (!(APP_PUBLISH_QUEUE_KINDS as readonly string[]).includes(row.kind)) continue;
    const kind = row.kind as AppPublishQueueKind;
    const pending = Number(row.pending);
    if (!Number.isFinite(pending) || pending <= 0) continue;
    const oldestMs = row.oldest == null ? NaN : new Date(row.oldest).getTime();
    out[kind] = {
      pending,
      oldestPendingSeconds: Number.isFinite(oldestMs) ? Math.max(0, (nowMs - oldestMs) / 1000) : 0,
    };
  }
  return out;
}

let snapshot: readonly AppPublishQueueRow[] | null = null;
let fetchedAt = 0;
let inflight: Promise<void> | null = null;

async function queryAppPublishQueue(): Promise<AppPublishQueueRow[]> {
  // Lazy import: keeps this module DB-free until a real scrape needs it.
  const { pgDbRead } = await import('~/server/db/pgDb');
  const db = await pgDbRead.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL statement_timeout = ${APP_PUBLISH_QUEUE_STATEMENT_TIMEOUT_MS}`);
    const result = await db.query<AppPublishQueueRow>(
      `SELECT 'block' AS kind, count(*)::int AS pending, min(submitted_at) AS oldest
         FROM app_block_publish_requests WHERE status = 'pending'
       UNION ALL
       SELECT 'listing' AS kind, count(*)::int AS pending, min(submitted_at) AS oldest
         FROM app_listing_publish_requests WHERE status = 'pending'`
    );
    await db.query('COMMIT');
    return result.rows;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    db.release();
  }
}

function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = queryAppPublishQueue()
    .then((rows) => {
      snapshot = rows;
      fetchedAt = Date.now();
    })
    .catch(() => {
      // Keep the last good snapshot: a replica hiccup must not fail the scrape.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function maybeRefresh() {
  if (Date.now() - fetchedAt > APP_PUBLISH_QUEUE_TTL_MS) void refresh();
}

/** The snapshot to serve now: null before the first good read and once it is too old. */
function servableSnapshot(): readonly AppPublishQueueRow[] | null {
  if (!snapshot) return null;
  if (Date.now() - fetchedAt > APP_PUBLISH_QUEUE_MAX_STALENESS_MS) return null;
  return snapshot;
}

/** Get-or-create both gauges on `reg`. Idempotent. */
export function ensureRegisterAppPublishQueueMetrics(reg: Registry = client.register): void {
  if (!reg.getSingleMetric(APP_PUBLISH_QUEUE_OLDEST_SECONDS)) {
    new client.Gauge({
      name: APP_PUBLISH_QUEUE_OLDEST_SECONDS,
      help: 'Age in seconds of the oldest PENDING app publish request awaiting moderator review, by kind (block = an app version, listing = a store listing); 0 when none is pending. PER POD: aggregate with max(), never sum(). Absent until the first successful read on this pod, and again after 10 minutes without one',
      labelNames: ['kind'],
      registers: [reg],
      collect() {
        maybeRefresh();
        this.reset();
        const current = servableSnapshot();
        if (!current) return;
        const values = computeAppPublishQueueGauges(current, Date.now());
        for (const kind of APP_PUBLISH_QUEUE_KINDS) {
          this.set({ kind }, values[kind].oldestPendingSeconds);
        }
      },
    });
  }
  if (!reg.getSingleMetric(APP_PUBLISH_QUEUE_PENDING_COUNT)) {
    new client.Gauge({
      name: APP_PUBLISH_QUEUE_PENDING_COUNT,
      help: 'App publish requests PENDING moderator review, by kind (block = an app version, listing = a store listing). PER POD: aggregate with max(), never sum(). Absent until the first successful read on this pod, and again after 10 minutes without one',
      labelNames: ['kind'],
      registers: [reg],
      collect() {
        maybeRefresh();
        this.reset();
        const current = servableSnapshot();
        if (!current) return;
        const values = computeAppPublishQueueGauges(current, Date.now());
        for (const kind of APP_PUBLISH_QUEUE_KINDS) this.set({ kind }, values[kind].pending);
      },
    });
  }
}

ensureRegisterAppPublishQueueMetrics();

/** Test seam: install a snapshot as if a read had just succeeded (`null` = never read). */
export function __setAppPublishQueueSnapshotForTest(rows: readonly AppPublishQueueRow[] | null) {
  snapshot = rows;
  fetchedAt = rows ? Date.now() : 0;
}
