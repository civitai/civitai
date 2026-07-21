import { MeiliSearch } from 'meilisearch'
import { IndexUpdate } from '../types/events'
import { logger } from '../utils/logger'
import { config } from '../config'
import { indexQueueMetrics } from '@/metrics'
import { IClickhouseClient, IDbClient, IRedisClient } from '@/common/types/package-stubs'
import { MetricService } from '@/common/services/metrics'
import { CacheService } from '@/common/services/cache'
import * as feeds from '@/common/feeds'
import { UpsertType } from '@/common/feeds/types'

/**
 * Manages queued updates to Meilisearch indices using the feed system
 */
export class IndexUpdateQueue {
  private updates: Map<string, Set<number>> = new Map()
  private interval: NodeJS.Timeout | null = null
  private feeds: Record<string, any> = {}

  constructor(
    private ch: IClickhouseClient,
    private pg: IDbClient,
    private redis: IRedisClient,
    private metricService: MetricService,
    private cacheService: CacheService,
    private updateIntervalMs: number = config.app.indexUpdateIntervalMs,
    private maxBatchSize: number = 1000
  ) {
    this.initializeFeeds()
  }

  /**
   * Initialize all feeds from the feed registry
   */
  private initializeFeeds(): void {
    // Initialize all feeds using barrel export
    for (const [name, Feed] of Object.entries(feeds)) {
      // Skip non-class exports (types, etc.)
      if (typeof Feed !== 'function') continue

      try {
        // Each feed creates its own Meilisearch client internally
        this.feeds[name.toLowerCase().replace('feed', '')] = new Feed(
          ({ host, apiKey }) => new MeiliSearch({ host, apiKey }),
          this.ch,
          this.pg,
          this.metricService,
          this.cacheService
        )
        logger.info(`Initialized ${name} feed`)
      } catch (err) {
        logger.error({ err, feedName: name }, `Failed to initialize ${name} feed`)
      }
    }
  }

  /**
   * Start the index update processor
   */
  async start(): Promise<void> {
    if (!config.app.indexUpdateEnabled) {
      logger.info('Index update queue disabled via INDEX_UPDATE_ENABLED=false')
      return
    }

    if (this.interval) return

    this.interval = setInterval(() => {
      this.flush().catch(err => {
        logger.error({ err }, 'Failed to flush index updates')
      })
    }, this.updateIntervalMs)

    logger.info(`Index update queue started (interval: ${this.updateIntervalMs}ms)`)
  }

  /**
   * Stop the index update processor
   */
  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }

    // Final flush
    await this.flush()

    logger.info('Index update queue stopped')
  }

  /**
   * Add an index update to the queue
   */
  add(update: IndexUpdate): void {
    if (!config.app.indexUpdateEnabled) return

    const entityKey = update.entityType.toLowerCase()

    if (!this.updates.has(entityKey)) {
      this.updates.set(entityKey, new Set())
    }

    this.updates.get(entityKey)!.add(update.entityId)

    // Update queue size metric
    indexQueueMetrics.queueSize.set({ entity_type: entityKey }, this.updates.get(entityKey)!.size)

    // Check if we should flush early
    const totalQueued = Array.from(this.updates.values())
      .reduce((sum, set) => sum + set.size, 0)

    if (totalQueued >= this.maxBatchSize) {
      this.flush().catch(err => {
        logger.error({ err }, 'Failed to flush at max batch size')
      })
    }
  }

  /**
   * Flush all pending index updates
   */
  async flush(): Promise<void> {
    if (this.updates.size === 0) return

    // Take all current updates
    const batches = new Map(this.updates)
    this.updates.clear()

    await this.processBatches(batches)
  }

  /**
   * Process index update batches
   */
  private async processBatches(batches: Map<string, Set<number>>): Promise<void> {
    const promises: Promise<void>[] = []

    for (const [entityType, entityIds] of batches.entries()) {
      if (entityIds.size === 0) continue

      promises.push(this.updateIndex(entityType, Array.from(entityIds)))
    }

    try {
      await Promise.all(promises)

      logger.debug(`Flushed index updates for ${batches.size} entity types`)
    } catch (err) {
      logger.error({ err }, 'Failed to flush some index updates')
      indexQueueMetrics.batchesFailed.inc()

      // Re-queue failed updates
      for (const [entityType, entityIds] of batches.entries()) {
        if (!this.updates.has(entityType)) {
          this.updates.set(entityType, new Set())
        }
        entityIds.forEach(id => this.updates.get(entityType)!.add(id))
      }

      // Update queue size metrics after re-queueing
      for (const [entityType, entityIds] of this.updates.entries()) {
        indexQueueMetrics.queueSize.set({ entity_type: entityType }, entityIds.size)
      }
    }
  }

  /**
   * Update a specific index with entity IDs using the feed system
   *
   * @param entityType - The entity type (e.g., 'image', 'model', 'post')
   * @param entityIds - Array of entity IDs to update
   * @param type - Type of update ('full' or 'metrics')
   */
  private async updateIndex(
    entityType: string,
    entityIds: number[],
    type: UpsertType = 'full'
  ): Promise<void> {
    const feed = this.feeds[entityType]
    if (!feed) {
      logger.warn(`No feed configured for entity type: ${entityType}`)
      return
    }

    const endTimer = indexQueueMetrics.batchFlushDuration.startTimer({ entity_type: entityType })

    try {
      // Use feed to upsert documents
      // The feed handles:
      // - Fetching base data from PostgreSQL
      // - Fetching metrics from ClickHouse via MetricService
      // - Batching updates to Meilisearch
      await feed.upsert(entityIds, type)

      endTimer()

      // Update Prometheus metrics
      indexQueueMetrics.batchesFlushed.inc({ entity_type: entityType })
      indexQueueMetrics.updatesProcessed.inc({ entity_type: entityType }, entityIds.length)
      indexQueueMetrics.queueSize.set({ entity_type: entityType }, 0)

      logger.debug(`Updated ${entityIds.length} ${entityType} documents via feed`)
    } catch (err) {
      endTimer()
      logger.error(
        {
          err,
          entityIds: entityIds.slice(0, 10), // Log first 10 IDs
        },
        `Failed to update ${entityType} index via feed`
      )
      throw err
    }
  }

  /**
   * Get current statistics
   * Note: This updates Prometheus gauges with current values
   */
  getStats() {
    // Update queue size metrics
    for (const [entityType, entityIds] of this.updates.entries()) {
      indexQueueMetrics.queueSize.set({ entity_type: entityType }, entityIds.size)
    }

    return {
      currentQueueSize: Array.from(this.updates.values())
        .reduce((sum, set) => sum + set.size, 0),
      queuedByType: Object.fromEntries(
        Array.from(this.updates.entries())
          .map(([type, set]) => [type, set.size])
      )
    }
  }
}
