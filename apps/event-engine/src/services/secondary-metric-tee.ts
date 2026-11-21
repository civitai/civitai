import { ClickHouseClient, createClient } from '@clickhouse/client';
import { config, SecondaryClickhouseConfig } from '../config';
import { logger } from '../utils/logger';
import { secondaryTeeMetrics } from '@/metrics';

/** One row of the metric events table, exactly as the primary insert writes it. */
export type MetricEventRow = {
  entityId: number | null | undefined;
  entityType: string;
  metricType: string;
  metricValue: number;
  userId: number;
  createdAt: Date;
};

/** The only surface MetricEventBatcher needs: a synchronous, never-throwing hand-off. */
export interface MetricRowSink {
  enqueue(rows: MetricEventRow[]): void;
  stop(timeoutMs?: number): Promise<void>;
}

type InsertClient = Pick<ClickHouseClient, 'insert' | 'close'>;

/** A single secondary insert is abandoned (and retried later) after this long. */
export const SECONDARY_INSERT_TIMEOUT_MS = 10_000;
/** Upper bound on the best-effort drain at shutdown. */
export const SECONDARY_SHUTDOWN_TIMEOUT_MS = 5_000;
/**
 * Most rows sent in one secondary insert. The primary flushes at 10k rows in steady state, so a
 * normal batch goes out unsplit; a backlog flush (the primary drains its whole queue, up to 500k
 * rows, after an outage) is split so no single insert encodes the whole backlog at once and the
 * overflow bound drops whole chunks instead of whole backlogs.
 */
export const SECONDARY_SEND_CHUNK_ROWS = 10_000;

export type SecondaryMetricTeeOptions = {
  /** Fully-qualified target table, e.g. `metrics.entityMetricEvents_month`. */
  table: string;
  /** Rows held for the secondary (queued + in flight) before the oldest queued chunks drop. */
  maxQueueRows: number;
  insertTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
};

type DropReason = 'overflow' | 'shutdown';

/**
 * Copies metric event rows to a second ClickHouse destination without ever touching the
 * primary path: enqueue() is synchronous and swallows everything, and the sends happen on
 * this object's own loop with its own client.
 *
 * Incoming rows are split into chunks of at most `chunkRows` (SECONDARY_SEND_CHUNK_ROWS, or
 * half the bound when the bound is smaller, so one chunk in flight plus one queued always fits).
 * The rows held (queued + the chunk in flight) are bounded by maxQueueRows: when over it the
 * OLDEST queued chunks are dropped and counted, because the destination's gaps are repaired out
 * of band. A failed insert is retried with capped exponential backoff; the rows are idempotent
 * downstream, so a retry that duplicates a slow-but-successful insert is fine.
 *
 * Sends start on a later event-loop turn (setImmediate), never inside enqueue(): the client
 * encodes array values synchronously when insert() is called, and that must not happen on the
 * caller's path.
 */
export class SecondaryMetricTee implements MetricRowSink {
  private queue: MetricEventRow[][] = [];
  private queuedRows = 0;
  private inFlightRows = 0;
  private pumpPromise: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private draining = false;
  private stopped = false;
  private cancelSleep: (() => void) | null = null;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly insertTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly chunkRows: number;

  constructor(private client: InsertClient, private opts: SecondaryMetricTeeOptions) {
    this.baseBackoffMs = opts.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.insertTimeoutMs = opts.insertTimeoutMs ?? SECONDARY_INSERT_TIMEOUT_MS;
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs ?? SECONDARY_SHUTDOWN_TIMEOUT_MS;
    this.chunkRows = Math.max(
      1,
      Math.min(SECONDARY_SEND_CHUNK_ROWS, Math.floor(opts.maxQueueRows / 2))
    );
  }

  enqueue(rows: MetricEventRow[]): void {
    try {
      if (this.stopped || rows.length === 0) return;
      for (let i = 0; i < rows.length; i += this.chunkRows) {
        const chunk = rows.slice(i, i + this.chunkRows);
        this.queue.push(chunk);
        this.queuedRows += chunk.length;
        this.enforceBound();
      }
      this.updateGauge();
      if (!this.pumpPromise) this.startPump();
    } catch (err) {
      logger.error({ err }, 'Secondary metric tee enqueue failed; batch not sent to the secondary');
    }
  }

  /** Rows waiting to be sent (excludes the chunk in flight). */
  get pendingRows(): number {
    return this.queuedRows;
  }

  /** Resolves when the send loop is idle. For tests and shutdown; never rejects. */
  async idle(): Promise<void> {
    while (this.pumpPromise) await this.pumpPromise;
  }

  /**
   * Best-effort drain, bounded by timeoutMs, then close the client. Never throws and never
   * waits longer than about timeoutMs (+ at most 1s for close()).
   */
  async stop(timeoutMs: number = this.shutdownTimeoutMs): Promise<void> {
    if (this.stopped) return;
    this.draining = true;
    this.cancelSleep?.();
    if (!this.pumpPromise && this.queue.length > 0) this.startPump();

    await raceTimeout(this.idle(), timeoutMs);

    this.stopped = true;
    this.cancelSleep?.();
    while (this.queue.length > 0) this.drop(this.shiftOldest(), 'shutdown');
    this.updateGauge();

    try {
      await raceTimeout(this.client.close(), Math.min(timeoutMs, 1_000));
    } catch (err) {
      logger.warn({ err }, 'Secondary metric tee client close failed');
    }
  }

  private startPump(): void {
    // Yield to the event loop first: insert() encodes the rows synchronously, and that must
    // not run on enqueue()'s caller's path.
    this.pumpPromise = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.pump())
      .catch((err) => {
        logger.error({ err }, 'Secondary metric tee send loop crashed');
      })
      .finally(() => {
        this.pumpPromise = null;
      });
  }

  private async pump(): Promise<void> {
    while (!this.stopped && this.queue.length > 0) {
      const batch = this.shiftOldest();
      this.inFlightRows = batch.length;
      this.updateGauge();

      try {
        await this.insert(batch);
        this.inFlightRows = 0;
        secondaryTeeMetrics.rowsSent.inc(batch.length);
        this.consecutiveFailures = 0;
      } catch (err) {
        this.inFlightRows = 0;
        secondaryTeeMetrics.batchesFailed.inc();
        this.consecutiveFailures++;
        logger.warn(
          { err, rows: batch.length, consecutiveFailures: this.consecutiveFailures },
          'Secondary metric insert failed; will retry'
        );
        if (this.stopped) {
          this.drop(batch, 'shutdown');
          this.updateGauge();
          return;
        }
        // Back at the head: it is the oldest, so it is the first to go if the queue is over.
        this.queue.unshift(batch);
        this.queuedRows += batch.length;
        this.enforceBound();
        this.updateGauge();
        // While draining at shutdown a failure ends the attempt; stop() drops the rest.
        if (this.draining) return;
        await this.sleep(this.backoffMs());
      }
      this.updateGauge();
    }
  }

  private async insert(batch: MetricEventRow[]): Promise<void> {
    const abort = new AbortController();
    const sent = this.client.insert({
      table: this.opts.table,
      values: batch,
      format: 'JSONEachRow',
      clickhouse_settings: { insert_quorum: '2' },
      abort_signal: abort.signal,
    });
    // If the timeout wins, the aborted insert rejects later; that rejection is expected.
    sent.catch(() => undefined);
    await raceTimeout(sent, this.insertTimeoutMs, () => {
      abort.abort();
      throw new Error(`secondary insert timed out after ${this.insertTimeoutMs}ms`);
    });
  }

  /** Drop the oldest queued chunks until the rows held (queued + in flight) are within the bound. */
  private enforceBound(): void {
    while (this.queuedRows + this.inFlightRows > this.opts.maxQueueRows && this.queue.length > 0) {
      this.drop(this.shiftOldest(), 'overflow');
    }
  }

  private shiftOldest(): MetricEventRow[] {
    const batch = this.queue.shift()!;
    this.queuedRows -= batch.length;
    return batch;
  }

  /** Count a batch that will never be sent. The caller has already taken it off the queue. */
  private drop(batch: MetricEventRow[], reason: DropReason): void {
    secondaryTeeMetrics.batchesDropped.inc({ reason });
    secondaryTeeMetrics.rowsDropped.inc({ reason }, batch.length);
  }

  private backoffMs(): number {
    const exp = this.baseBackoffMs * 2 ** Math.min(this.consecutiveFailures - 1, 16);
    return Math.min(exp, this.maxBackoffMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.cancelSleep = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.cancelSleep = done;
    });
  }

  private updateGauge(): void {
    secondaryTeeMetrics.queueRows.set(this.queuedRows + this.inFlightRows);
  }
}

/**
 * Resolves/rejects with `p`, or after `ms` calls onTimeout (default: resolve undefined).
 * The timer is always cleared, so it never holds the process open.
 */
async function raceTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout?: () => never
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve, reject) => {
    timer = setTimeout(() => {
      if (!onTimeout) return resolve(undefined);
      try {
        onTimeout();
      } catch (err) {
        reject(err);
      }
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The secondary tee for this process, or null when it is off (the default) — in which case no
 * secondary client is created at all.
 */
export function createSecondaryMetricTee(
  cfg: SecondaryClickhouseConfig = config.clickhouse.secondary,
  table: string = config.clickhouse.metricEventsTable,
  makeClient: typeof createClient = createClient
): SecondaryMetricTee | null {
  if (!cfg.enabled) return null;

  let client: InsertClient;
  try {
    // createClient validates the URL synchronously; a bad one must not take the primary down.
    client = makeClient({
      url: cfg.url,
      username: cfg.username,
      password: cfg.password,
      database: cfg.database,
      request_timeout: SECONDARY_INSERT_TIMEOUT_MS,
      // One send at a time; a second socket covers a stuck one being torn down.
      max_open_connections: 2,
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Secondary metric tee disabled: could not create its ClickHouse client (check CLICKHOUSE_SECONDARY_URL)'
    );
    return null;
  }
  logger.info({ database: cfg.database, table }, 'Secondary metric tee enabled');
  return new SecondaryMetricTee(client, {
    table: `${cfg.database}.${table}`,
    maxQueueRows: cfg.maxQueueRows,
  });
}
