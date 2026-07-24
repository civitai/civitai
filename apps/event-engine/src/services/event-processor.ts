import { Pool } from 'pg'
import { ClickHouseClient, createClient } from '@clickhouse/client'
import pLimit from 'p-limit'
import { config } from '@/config'
import { logger } from '@/utils/logger'
import { eventHandlers } from '@/handlers'
import { mapOperation, getTableFromTopic, MetricEvent, CacheUpdate, FeedUpdate, Operation, KafkaOffsetMeta } from '@/types/events'
import { MetricEventBatcher } from '@/services/metric-event-batcher'
import { IndexUpdateQueue } from '@/services/index-update-queue'
import { RedisCache } from '@/services/redis-cache'
import { QueryCacheManager } from '@/services/query-cache-manager'
import { metricSignals } from '@/services/metric-signals'
import { OutboxService, OutboxRecord } from '@/common/services/outbox'
import { getOutboxHandlers } from '@/handlers/outbox/index'
import { OutboxPoller } from '@/services/outbox-poller'
import { spineService } from '@/services/spine'
import { HandlerContext, EventHandler, HandlerActions, FeedUpdateType } from '@/types/handlers'
import { createEventHandlerMapper } from '@/utils/handler-mapper'
import { eventProcessorMetrics, queryCacheMetrics } from '@/metrics'
import { MetricService } from '@/common/services/metrics'
import { CacheService } from '@/common/services/cache'
import { CacheDriftMonitor } from '@/services/cache-drift-monitor'

interface HandlerEntry {
  name: string
  handler: EventHandler
}

export interface DispatchMeta {
  topic: string
  partition: number
  offset: string
}

export class EventProcessor {
  private pgPool: Pool
  private chClient: ClickHouseClient
  private redisCache: RedisCache
  private queryCacheManager: QueryCacheManager | null = null
  private metricBatcher: MetricEventBatcher
  private indexQueue!: IndexUpdateQueue
  private metricService!: MetricService
  private cacheService!: CacheService
  private cacheDriftMonitor: CacheDriftMonitor | null = null
  private outboxService: OutboxService
  private outboxPoller: OutboxPoller | null = null
  private isRunning: boolean = false
  private limiter: ReturnType<typeof pLimit>
  private handlerMapper = createEventHandlerMapper<HandlerEntry>()

  private pgQueryMemoized!: (sql: string, params?: any[]) => Promise<any>
  private pgQueryOneMemoized!: (sql: string, params?: any[]) => Promise<any>

  constructor(maxConcurrency?: number) {
    const concurrency = maxConcurrency || config.app.workerPoolSize || 10
    this.limiter = pLimit(concurrency)

    this.pgPool = new Pool({
      connectionString: config.postgres.connectionString,
      max: config.cache.pgPoolMaxConnections
    })

    this.chClient = createClient({
      host: config.clickhouse.url
    })

    this.redisCache = new RedisCache(config.redis.url)
    this.metricBatcher = new MetricEventBatcher(this.chClient)
    this.outboxService = new OutboxService(this.pgPool)

    this.buildHandlerMap()

    logger.info(`Event processor initialized with concurrency limit: ${concurrency}`)
  }

  private buildHandlerMap(): void {
    Object.entries(eventHandlers).forEach(([name, handler]) => {
      const entry: HandlerEntry = { name, handler }
      this.handlerMapper.register(entry, name)
    })

    const stats = this.handlerMapper.getStats()
    logger.info(`Pre-computed handler mappings: ${stats.mappings} combinations, ${stats.totalHandlers} total handlers`)
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    this.isRunning = true

    await this.redisCache.connect()

    // Cache increments are applied inline in addMetricEvent via
    // redisCache.incrementOnce, which is idempotent per (entity, metric,
    // source message). Redelivery (rebalance/restart) re-runs handlers and
    // re-applies the same delta, but the dedupe marker makes the replay a
    // no-op — so we no longer need to defer the cache to a post-commit hook.

    const redisClient = await this.redisCache.getClient()

    this.metricService = new MetricService(this.chClient, redisClient)
    this.cacheService = new CacheService(
      redisClient,
      this.pgPool,
      this.chClient
    )

    this.indexQueue = new IndexUpdateQueue(
      this.chClient,
      this.pgPool,
      redisClient,
      this.metricService,
      this.cacheService
    )

    this.queryCacheManager = new QueryCacheManager(this.redisCache)

    this.pgQueryMemoized = this.queryCacheManager.createMemoizedQuery(
      async (sql: string, params?: any[]) => {
        const result = await this.pgPool.query(sql, params)
        return result.rows
      }
    )

    this.pgQueryOneMemoized = async (sql: string, params?: any[]) => {
      const results = await this.pgQueryMemoized(sql, params)
      return results[0] ?? null
    }

    await this.queryCacheManager.start()
    await this.metricBatcher.start()
    await this.indexQueue.start()

    // Drift canary: compares the Redis cache against deduped ClickHouse truth
    // for hot entities and emits mew_cache_drift_ratio. Defaults on; disable
    // with CACHE_DRIFT_MONITOR_ENABLED=false.
    if (process.env.CACHE_DRIFT_MONITOR_ENABLED !== 'false') {
      const driftIntervalMs = parseInt(process.env.CACHE_DRIFT_CHECK_INTERVAL_MS ?? '300000', 10)
      this.cacheDriftMonitor = new CacheDriftMonitor(this.chClient, redisClient, driftIntervalMs)
      this.cacheDriftMonitor.start()
    }

    // Outbox reconciliation poller: drains aged Outbox rows the live CDC path
    // never processed (created pre-connector, during downtime, or misses). Runs
    // the same entity handlers, deletes on success. Single-active across pods
    // via a pg advisory lock.
    if (config.app.outboxPollEnabled) {
      this.outboxPoller = new OutboxPoller(
        this.pgPool,
        (record) => this.processOutboxRecord(record),
        config.app.outboxPollIntervalMs,
        config.app.outboxPollGraceMs,
        config.app.outboxPollBatchSize,
        config.app.outboxMaxAttempts,
      )
      this.outboxPoller.start()
    }

    logger.info('Event processor started')
  }

  async stop(): Promise<void> {
    this.isRunning = false

    this.outboxPoller?.stop()
    this.cacheDriftMonitor?.stop()

    if (this.queryCacheManager) {
      await this.queryCacheManager.stop()
    }

    // Wait for in-flight handler tasks to finish naturally. We deliberately
    // do NOT call limiter.clearQueue() — that would discard pending tasks
    // and silently drop their offsets. Caller is expected to stop the
    // Kafka consumer first so no new work is enqueued.
    await this.drainLimiter()

    // Final flush. If this throws, propagate so the caller can avoid
    // committing offsets for events that aren't durable.
    await this.metricBatcher.stop()
    await this.indexQueue.stop()

    await this.pgPool.end()
    await this.chClient.close()
    await this.redisCache.disconnect()

    logger.info('Event processor stopped')
  }

  private async drainLimiter(timeoutMs = 30000): Promise<void> {
    const start = Date.now()
    while (this.limiter.activeCount + this.limiter.pendingCount > 0) {
      if (Date.now() - start > timeoutMs) {
        logger.warn(
          {
            active: this.limiter.activeCount,
            pending: this.limiter.pendingCount,
          },
          `Limiter drain timed out after ${timeoutMs}ms`
        )
        return
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  getMetricBatcher(): MetricEventBatcher {
    return this.metricBatcher
  }

  /**
   * Dispatch a Kafka event to all matching handlers. Returns a promise that
   * resolves when every handler has finished (including any side-effects
   * the handler itself awaits). A resolved promise means "events have been
   * queued in their downstream batchers" — not that they're durable yet.
   * Durability is announced via MetricEventBatcher.onFlushed.
   */
  async handleKafkaEvent(payload: any, topic: string, kafkaMeta: KafkaOffsetMeta): Promise<void> {
    if (!this.isRunning) return

    const isDebezium = payload.op && ('before' in payload || 'after' in payload)

    let lookupKey: string
    let operation: Operation | undefined

    if (isDebezium) {
      operation = mapOperation(payload.op)
      const tableName = getTableFromTopic(topic)
      lookupKey = `${tableName}:${operation}`

      eventProcessorMetrics.messagesReceived.inc({ topic: tableName, operation })
    } else {
      lookupKey = topic
      eventProcessorMetrics.messagesReceived.inc({ topic, operation: 'n/a' })
    }

    const handlers = this.handlerMapper.get(lookupKey)

    if (handlers.length === 0) {
      eventProcessorMetrics.messagesIgnored.inc({ topic, operation: operation || 'n/a' })
      // Still need to advance the commit cursor for ignored messages.
      this.metricBatcher.markOffset(kafkaMeta)
      return
    }

    logger.debug(`Processing ${handlers.length} handler(s) for ${lookupKey}`)

    const completions = handlers.map(({ name, handler }) => {
      eventProcessorMetrics.handlersMatched.inc({ topic, operation: operation || 'n/a', handler: name })
      eventProcessorMetrics.eventsQueued.inc({ handler: name })

      return this.limiter(() => this.processEvent(payload, handler, name, kafkaMeta))
    })

    // Wait for every handler to finish so the caller can mark this Kafka
    // offset as "dispatched" with no in-flight work behind it.
    await Promise.all(completions)

    // Ensure the offset is recorded even if no handler emitted a metric
    // event for it (e.g. handler ran but only updated feeds/redis).
    this.metricBatcher.markOffset(kafkaMeta)
  }

  private async processEvent(
    payload: any,
    handler: EventHandler,
    handlerName: string,
    kafkaMeta: KafkaOffsetMeta,
  ): Promise<void> {
    const endTimer = eventProcessorMetrics.eventProcessingDuration.startTimer({ handler: handlerName })

    try {
      const context = this.createHandlerContext(payload, kafkaMeta)
      await handler.process(context)

      endTimer()
      eventProcessorMetrics.eventsProcessed.inc({ handler: handlerName, status: 'success' })
    } catch (err) {
      endTimer()
      eventProcessorMetrics.eventsFailed.inc({ handler: handlerName })
      eventProcessorMetrics.eventsProcessed.inc({ handler: handlerName, status: 'failed' })

      logger.error({ err, handlerName, kafkaMeta }, 'Handler failed; bubbling for Kafka redelivery')
      // Surface the error so the Kafka consumer can avoid committing this
      // offset. The next poll cycle will redeliver the message. ClickHouse
      // dedupes via the entityMetricEvents_month ReplacingMergeTree key.
      throw err
    }
  }

  private createHandlerContext(payload: any, kafkaMeta: KafkaOffsetMeta): HandlerContext {
    const isDebezium = payload.op && ('before' in payload || 'after' in payload)
    const operation = isDebezium ? mapOperation(payload.op) : 'create'

    // Derive a deterministic timestamp from the source event so replays
    // produce identical (entityType, entityId, metricType, userId, createdAt)
    // keys — required for ClickHouse ReplacingMergeTree dedup to collapse
    // duplicates introduced by Kafka redelivery.
    const eventTimestamp = this.deriveEventTimestamp(payload)

    return {
      pg: {
        query: this.pgQueryMemoized,
        queryOne: this.pgQueryOneMemoized,
        exec: async (sql: string, params?: any[]) => {
          const result = await this.pgPool.query(sql, params)
          return result.rowCount || 0
        }
      },
      ch: {
        query: async (sql: string) => {
          const result = await this.chClient.query({
            query: sql,
            format: 'JSONEachRow'
          })
          return await result.json()
        },
        insert: async (table: string, data: any[]) => {
          await this.chClient.insert({
            table,
            values: data,
            format: 'JSONEachRow'
          })
        }
      },
      old: isDebezium ? payload.before : undefined,
      current: isDebezium ? payload.after : payload,
      record: isDebezium ? (['create', 'update'].includes(operation) ? payload.after : payload.before) : payload,
      operation,
      actions: this.createActions(kafkaMeta, eventTimestamp)
    }
  }

  /**
   * Process a single Outbox row outside the Kafka path (used by OutboxPoller).
   * Builds a handler context for the row and runs its entity handlers. The
   * caller owns row deletion, so this only runs handlers and lets errors
   * propagate — the poller leaves a failed row for a later sweep.
   */
  async processOutboxRecord(record: OutboxRecord): Promise<void> {
    // Synthetic offset meta: the poller never commits Kafka offsets, and
    // addMetricEvent only carries _kafka as passthrough metadata (the commit
    // cursor is advanced solely by markOffset on the Kafka path), so a dummy
    // meta here is inert.
    const kafkaMeta = { topic: 'outbox-poller', partition: 0, offset: '0' }
    const context = this.createHandlerContext(record, kafkaMeta)

    const handlers = getOutboxHandlers(record.entityType, record.event)
    for (const handler of handlers) {
      await handler.process({
        ...context,
        event: record.event,
        entityType: record.entityType,
        entityId: record.entityId,
        details: record.details ?? undefined,
      })
    }
  }

  private deriveEventTimestamp(payload: any): Date {
    // Debezium puts the source DB commit time in source.ts_ms and the
    // envelope time in ts_ms. source.ts_ms is the most stable across
    // replays. Falls back to envelope ts_ms, then now() for non-Debezium.
    const sourceTs = payload?.source?.ts_ms
    if (typeof sourceTs === 'number' && sourceTs > 0) return new Date(sourceTs)
    const envelopeTs = payload?.ts_ms
    if (typeof envelopeTs === 'number' && envelopeTs > 0) return new Date(envelopeTs)
    return new Date()
  }

  private createActions(kafkaMeta: KafkaOffsetMeta, eventTimestamp: Date): HandlerActions {
    const actions: HandlerActions = {
      incMetricCache: async (update: CacheUpdate | CacheUpdate[]) => {
        await this.redisCache.increment(update)
        if (!Array.isArray(update)) await metricSignals.sendDelta(update)
      },
      addMetricEvent: (event: MetricEvent) => {
        if (event.entityId == null || !event.userId) {
          eventProcessorMetrics.eventsDropped.inc({ handler: 'addMetricEvent', reason: 'missing_id_or_user' })
          return
        }

        const enriched: MetricEvent = {
          ...event,
          timestamp: event.timestamp ?? eventTimestamp,
          _kafka: kafkaMeta,
        }

        this.metricBatcher.add(enriched)
        // Apply the cache increment inline. incrementOnce is idempotent per
        // (entity, metric, source message), so a rebalance/restart replay
        // re-applying this same delta is a no-op — no need to wait for the
        // batch to commit. Best-effort and fire-and-forget: a Redis blip must
        // not block handler processing (the cold-key/IfExists path means
        // untracked entities are simply skipped until a reader populates them).
        void this.redisCache.incrementOnce(enriched)
        // Signals are ephemeral live hints, emitted immediately for snappy UI.
        void metricSignals.sendDelta(enriched as CacheUpdate)
      },
      feedUpdate: (entityType: FeedUpdate['entityType'], entityId: FeedUpdate['entityId'], type: FeedUpdateType = 'update') => {
        if (entityId == null) return
        this.indexQueue.add({ entityType, entityId: entityId as number, type })
      },
      feedDelete: (entityType: FeedUpdate['entityType'], entityId: FeedUpdate['entityId']) =>
        actions.feedUpdate(entityType, entityId, 'delete'),
      feedMetricUpdate: (entityType: FeedUpdate['entityType'], entityId: FeedUpdate['entityId']) =>
        actions.feedUpdate(entityType, entityId, 'metricUpdate'),
      outboxRemove: async (id: number) => {
        await this.outboxService.delete(id)
      },
      forMetric: (entityType: MetricEvent['entityType'], entityId: MetricEvent['entityId']) => ({
        as: (userId: MetricEvent['userId']) => {
          const safeMetricAdd = (metricType: MetricEvent['metricType'], metricValue: number) => {
            if (entityId == null || !userId) return
            actions.addMetricEvent({ entityId, entityType, userId, metricType, metricValue })
          }

          return {
            add: (metricType: MetricEvent['metricType'], metricValue = 1) =>
              safeMetricAdd(metricType, metricValue),
            remove: (metricType: MetricEvent['metricType'], metricValue = 1) =>
              safeMetricAdd(metricType, -metricValue)
          }
        }
      }),
      spine: {
        req: async (request) => {
          await spineService.submitWorkflow(request)
        }
      }
    }

    return actions
  }

  getStats() {
    eventProcessorMetrics.activeTasks.set(this.limiter.activeCount)
    eventProcessorMetrics.pendingTasks.set(this.limiter.pendingCount)

    if (this.queryCacheManager) {
      const cacheStats = this.queryCacheManager.getStats()
      queryCacheMetrics.size.set(cacheStats.size)
      queryCacheMetrics.count.set(cacheStats.count)
    }

    return {
      activeTasks: this.limiter.activeCount,
      pendingTasks: this.limiter.pendingCount,
      concurrencyLimit: (this.limiter as any).concurrency,
      handlerStats: this.handlerMapper.getStats(),
      queryCache: this.queryCacheManager?.getStats() || null,
      batcher: this.metricBatcher.getStats(),
    }
  }
}

let instance: EventProcessor | null = null

export function getEventProcessor(): EventProcessor {
  if (!instance) {
    instance = new EventProcessor()
  }
  return instance
}
