import { ClickHouseClient } from '@clickhouse/client'
import { MetricEvent, KafkaOffsetMeta } from '../types/events'
import { logger } from '../utils/logger'
import { config } from '../config'
import { metricBatcherMetrics } from '@/metrics'

export type OffsetSnapshot = Map<string, string>

type FlushSubscriber = (snapshot: OffsetSnapshot) => void | Promise<void>

const partitionKey = (topic: string, partition: number) => `${topic}:${partition}`

/**
 * Batches metric events for efficient insertion into ClickHouse.
 *
 * Tracks the highest Kafka offset per (topic, partition) that has entered the
 * queue. On a successful flush the snapshot of those offsets is emitted to
 * subscribers, so the consumer can commit "up to and including" that offset
 * to Kafka — events earlier than the snapshot are now durable in ClickHouse.
 *
 * On flush failure events are re-queued and the high-water marks are
 * restored so the next flush retries the same range.
 */
/**
 * Thrown by add() when the queue exceeds maxQueueSize. The Kafka consumer
 * uses this to apply backpressure: re-throwing out of eachBatch makes
 * KafkaJS back off until ClickHouse recovers and the queue drains.
 */
export class BatcherBackpressureError extends Error {
  constructor(queueSize: number, limit: number) {
    super(`MetricEventBatcher queue is full (${queueSize} >= ${limit})`)
    this.name = 'BatcherBackpressureError'
  }
}

export class MetricEventBatcher {
  private queue: MetricEvent[] = []
  private highWater: Map<string, string> = new Map()
  private flushSubscribers: FlushSubscriber[] = []
  private interval: NodeJS.Timeout | null = null
  private flushPromise: Promise<void> | null = null

  constructor(
    private chClient: ClickHouseClient,
    private batchIntervalMs: number = config.app.batchInsertIntervalMs,
    private maxBatchSize: number = 10000,
    // Hard cap on in-memory queue. Set high enough to absorb a transient
    // ClickHouse blip but low enough to fail before OOM. ~50× the normal
    // flush size.
    private maxQueueSize: number = 500_000,
  ) {}

  isUnderPressure(): boolean {
    return this.queue.length >= this.maxQueueSize
  }

  async start(): Promise<void> {
    if (this.interval) return

    this.interval = setInterval(() => {
      this.flush().catch(err => {
        logger.error({ err }, 'Failed to flush metric events')
      })
    }, this.batchIntervalMs)

    logger.info(`Metric event batcher started (interval: ${this.batchIntervalMs}ms)`)
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }

    // Drain the queue completely. A single flush() may only handle the
    // snapshot it took at entry; events added during that flush (or marks
    // accumulated for empty-handler messages) require another pass.
    // Bounded by attempts so a permanent ClickHouse outage doesn't hang
    // shutdown forever.
    const maxAttempts = 10
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.queue.length === 0 && this.highWater.size === 0) break
      try {
        await this.flush()
      } catch (err) {
        logger.error({ err, attempt }, 'Final flush failed; bailing out')
        // Rethrow so the caller knows offsets aren't durable.
        throw err
      }
    }

    if (this.queue.length > 0 || this.highWater.size > 0) {
      logger.warn(
        { queue: this.queue.length, marks: this.highWater.size },
        'Batcher stopped with residual queue/marks after max drain attempts',
      )
    }

    logger.info('Metric event batcher stopped')
  }

  /**
   * Add an event to the batch queue.
   *
   * Crucially we do NOT update the high-water mark here. If we did, a
   * handler that emits an event and then throws (or another handler for
   * the same Kafka message fails) would still advance the commit cursor
   * past a failed message. The commit cursor is only advanced via
   * markOffset(), called by the event processor after every handler for
   * the message has succeeded.
   */
  add(event: MetricEvent): void {
    if (this.queue.length >= this.maxQueueSize) {
      throw new BatcherBackpressureError(this.queue.length, this.maxQueueSize)
    }

    this.queue.push(event)
    metricBatcherMetrics.queueSize.set(this.queue.length)

    if (this.queue.length >= this.maxBatchSize) {
      this.flush().catch(err => {
        logger.error({ err }, 'Failed to flush at max batch size')
      })
    }
  }

  /**
   * Record a Kafka offset as durable-once-the-next-flush-succeeds. Called
   * by the event processor after every handler for a Kafka message has
   * resolved. This is the only path that advances the commit cursor.
   */
  markOffset(meta: KafkaOffsetMeta): void {
    this.recordOffset(meta)
  }

  private recordOffset(meta: KafkaOffsetMeta): void {
    const key = partitionKey(meta.topic, meta.partition)
    const prev = this.highWater.get(key)
    if (!prev || BigInt(meta.offset) > BigInt(prev)) {
      this.highWater.set(key, meta.offset)
    }
  }

  /**
   * Register a callback invoked after every successful flush with the
   * offset snapshot for that flush. The consumer uses this to commit
   * offsets only for events that are now durable in ClickHouse.
   */
  onFlushed(cb: FlushSubscriber): void {
    this.flushSubscribers.push(cb)
  }

  /**
   * Flush the current batch to ClickHouse. Single-flighted — concurrent
   * callers await the in-flight flush.
   */
  async flush(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise
      return
    }

    if (this.queue.length === 0 && this.highWater.size === 0) return

    const batch = this.queue.splice(0)
    const snapshot: OffsetSnapshot = new Map(this.highWater)
    this.highWater.clear()

    this.flushPromise = this.processBatch(batch, snapshot)
    try {
      await this.flushPromise
    } finally {
      this.flushPromise = null
    }
  }

  private async processBatch(batch: MetricEvent[], snapshot: OffsetSnapshot): Promise<void> {
    const endTimer = metricBatcherMetrics.batchFlushDuration.startTimer()

    try {
      if (batch.length > 0) {
        const rows = batch.map(event => ({
          entityId: event.entityId,
          entityType: event.entityType,
          metricType: event.metricType,
          metricValue: event.metricValue,
          userId: event.userId ?? 0,
          createdAt: event.timestamp ?? new Date(),
        }))

        await this.chClient.insert({
          table: config.clickhouse.metricEventsTable,
          values: rows,
          format: 'JSONEachRow',
        })
      }

      endTimer()

      // Commit offsets AFTER the insert succeeds, so a committed offset always
      // implies durability in ClickHouse. A commit failure simply leaves the
      // offsets uncommitted: Kafka redelivers the batch and the
      // entityMetricEvents ReplacingMergeTree dedupes the re-insert. The Redis
      // cache is applied inline + idempotently in the event processor, so it is
      // independent of this commit and needs no gating here.
      for (const cb of this.flushSubscribers) {
        try {
          await cb(snapshot)
        } catch (err) {
          logger.error({ err }, 'onFlushed subscriber threw; offsets stay uncommitted, batch will redeliver')
        }
      }

      metricBatcherMetrics.batchesFlushed.inc()
      metricBatcherMetrics.eventsInBatches.inc(batch.length)
      metricBatcherMetrics.queueSize.set(this.queue.length)

      logger.debug(`Flushed ${batch.length} metric events to ClickHouse`)
    } catch (err) {
      endTimer()
      metricBatcherMetrics.batchesFailed.inc()

      // Re-queue events and restore the high-water marks so the next flush
      // retries the same range. We always re-queue: dropping a batch is
      // exactly the silent-loss bug we're fixing.
      this.queue.unshift(...batch)
      for (const [key, offset] of snapshot) {
        const cur = this.highWater.get(key)
        if (!cur || BigInt(offset) > BigInt(cur)) {
          this.highWater.set(key, offset)
        }
      }
      metricBatcherMetrics.queueSize.set(this.queue.length)

      logger.error({ err, batchSize: batch.length }, 'Failed to insert metric batch')
      throw err
    }
  }

  getStats() {
    metricBatcherMetrics.queueSize.set(this.queue.length)
    return {
      currentQueueSize: this.queue.length,
      partitionsTracked: this.highWater.size,
    }
  }
}
