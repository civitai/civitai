import { LRUCache } from 'lru-cache'
import sizeof from 'object-sizeof'
import { gzipSync, gunzipSync } from 'zlib'
import { logger } from '@/utils/logger'
import { RedisCache } from '@/services/redis-cache'
import { config } from '@/config'
import { queryCacheMetrics } from '@/metrics'

interface CacheSyncMessage {
  type: 'set' | 'delete'
  key: string
  value?: any
  instanceId: string
}

/**
 * Fast hash for cache keys
 */
function makeKey(sql: string, params: any[]): string {
  const input = sql + (params.length > 0 ? JSON.stringify(params) : '')
  let hash1 = 0
  let hash2 = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash1 = (hash1 * 31 + char) | 0
    hash2 = (hash2 * 37 + char) | 0
  }
  return hash1.toString(36) + hash2.toString(36)
}

/**
 * Manages query cache with persistence and cross-instance synchronization
 *
 * Responsibilities:
 * - Provides memoized query functions
 * - Real-time sync via Redis pub/sub (when enabled)
 * - Periodic backups with leader election
 * - Cache restoration on startup
 */
export class QueryCacheManager {
  private cache: LRUCache<string, any>
  private redisCache: RedisCache
  private isRunning = false

  // Pub/Sub clients (only created if sync enabled)
  private publisher: any = null
  private subscriber: any = null
  public readonly instanceId: string

  // Backup timer
  private backupInterval: NodeJS.Timeout | null = null

  // Track if we're setting from sync to avoid infinite loops
  private settingFromSync = new Set<string>()

  // Track in-flight queries to prevent cache stampede
  private pending = new Map<string, Promise<any>>()

  constructor(redisCache: RedisCache) {
    this.redisCache = redisCache
    this.instanceId = `${process.env.HOSTNAME || 'local'}-${Date.now()}`

    // Create LRU cache with broadcasting built-in
    this.cache = this.createBroadcastingCache()
  }

  /**
   * Create an LRU cache that automatically broadcasts changes via pub/sub
   *
   * Note: We wrap set/delete methods instead of using LRU's lifecycle hooks because:
   * - `onInsert` hook doesn't fire on updates, only insertions
   * - `dispose` hook fires on ALL removals (evictions, TTL, deletes) - we only want explicit deletes
   * - Method wrapping gives precise control over what gets broadcasted to other instances
   */
  private createBroadcastingCache(): LRUCache<string, any> {
    const baseCache = new LRUCache<string, any>({
      maxSize: config.cache.queryCache.maxSize,
      sizeCalculation: (value, key) => sizeof(key) + sizeof(value),
      dispose: (_value, _key, reason) => {
        queryCacheMetrics.evictions.inc({ reason })
      }
    })

    // Wrap cache methods to broadcast changes
    const originalSet = baseCache.set.bind(baseCache)
    const originalDelete = baseCache.delete.bind(baseCache)

    baseCache.set = (key: string, value: any, options?: any) => {
      const result = originalSet(key, value, options)

      // Broadcast to other instances (unless this came from sync)
      if (!this.settingFromSync.has(key) && this.publisher) {
        this.broadcastSet(key, value).catch(err => {
          logger.error({ err, key }, 'Failed to broadcast cache set')
        })
      }

      return result
    }

    baseCache.delete = (key: string) => {
      const result = originalDelete(key)

      // Broadcast to other instances
      if (result && this.publisher) {
        this.broadcastDelete(key).catch(err => {
          logger.error({ err, key }, 'Failed to broadcast cache delete')
        })
      }

      return result
    }

    return baseCache
  }

  /**
   * Create a memoized query function
   */
  createMemoizedQuery<T = any>(
    queryFn: (sql: string, params: any[]) => Promise<T>
  ): (sql: string, params?: any[]) => Promise<T> {
    return async (sql: string, params: any[] = []): Promise<T> => {
      const key = makeKey(sql, params)

      // Check cache first
      if (this.cache.has(key)) {
        queryCacheMetrics.hits.inc()
        return this.cache.get(key)!
      }

      // Check if query is already in-flight
      const inFlight = this.pending.get(key)
      if (inFlight) {
        return inFlight
      }

      // Start new query and track it
      queryCacheMetrics.misses.inc()
      const promise = queryFn(sql, params)
        .then(result => {
          this.cache.set(key, result)
          this.pending.delete(key)
          return result
        })
        .catch(err => {
          this.pending.delete(key)
          throw err
        })

      this.pending.set(key, promise)
      return promise
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: this.cache.calculatedSize || 0,
      count: this.cache.size || 0,
    }
  }

  /**
   * Start cache management (sync + backup)
   */
  async start(): Promise<void> {
    if (this.isRunning) return

    try {
      // Restore cache from backup
      await this.restoreCache()

      // Start pub/sub sync if enabled
      if (config.cache.queryCache.syncEnabled) {
        await this.startSync()
      }

      // Start periodic backups
      this.startBackupTimer()

      this.isRunning = true
      logger.info({
        instanceId: this.instanceId,
        syncEnabled: config.cache.queryCache.syncEnabled,
        backupInterval: config.cache.queryCache.backupIntervalMs / 1000 + 's'
      }, 'Query cache manager started')
    } catch (err) {
      logger.error({ err }, 'Failed to start query cache manager')
      throw err
    }
  }

  /**
   * Stop cache management
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return

    try {
      // Stop pub/sub sync
      if (this.subscriber) {
        await this.subscriber.unsubscribe()
        await this.subscriber.quit()
      }
      if (this.publisher) {
        await this.publisher.quit()
      }

      // Stop backup timer
      if (this.backupInterval) {
        clearInterval(this.backupInterval)
        this.backupInterval = null
      }

      // Final backup if sync is disabled (if sync enabled, cache is already shared)
      if (!config.cache.queryCache.syncEnabled) {
        await this.backupCache()
      }

      this.isRunning = false
      logger.info('Query cache manager stopped')
    } catch (err) {
      logger.error({ err }, 'Error stopping query cache manager')
    }
  }

  /**
   * Start real-time cache sync via Redis pub/sub
   */
  private async startSync(): Promise<void> {
    const redis = await this.redisCache.getClient()

    // Create dedicated connections for pub/sub using duplicate()
    // This is required because pub/sub takes over the connection
    this.publisher = redis.duplicate()
    this.subscriber = redis.duplicate()

    await this.publisher.connect()
    await this.subscriber.connect()

    // Subscribe to sync channel
    await this.subscriber.subscribe('query-cache:sync', (message: string) => {
      this.handleSyncMessage(message)
    })

    logger.info({ instanceId: this.instanceId }, 'Cache sync enabled')
  }

  /**
   * Broadcast a cache set operation
   */
  private async broadcastSet(key: string, value: any): Promise<void> {
    try {
      const message: CacheSyncMessage = {
        type: 'set',
        key,
        value,
        instanceId: this.instanceId
      }

      await this.publisher.publish('query-cache:sync', JSON.stringify(message))
      queryCacheMetrics.syncMessagesSent.inc({ type: 'set' })
    } catch (err) {
      queryCacheMetrics.syncErrors.inc({ operation: 'broadcast_set' })
      throw err
    }
  }

  /**
   * Broadcast a cache delete operation
   */
  private async broadcastDelete(key: string): Promise<void> {
    try {
      const message: CacheSyncMessage = {
        type: 'delete',
        key,
        instanceId: this.instanceId
      }

      await this.publisher.publish('query-cache:sync', JSON.stringify(message))
      queryCacheMetrics.syncMessagesSent.inc({ type: 'delete' })
    } catch (err) {
      queryCacheMetrics.syncErrors.inc({ operation: 'broadcast_delete' })
      throw err
    }
  }

  /**
   * Handle incoming sync messages
   */
  private handleSyncMessage(messageStr: string): void {
    try {
      const message: CacheSyncMessage = JSON.parse(messageStr)

      // Ignore our own messages
      if (message.instanceId === this.instanceId) return

      switch (message.type) {
        case 'set':
          this.settingFromSync.add(message.key)
          this.cache.set(message.key, message.value)
          this.settingFromSync.delete(message.key)
          queryCacheMetrics.syncMessagesReceived.inc({ type: 'set' })
          logger.debug({ key: message.key, from: message.instanceId }, 'Synced cache entry')
          break

        case 'delete':
          this.cache.delete(message.key)
          queryCacheMetrics.syncMessagesReceived.inc({ type: 'delete' })
          logger.debug({ key: message.key, from: message.instanceId }, 'Deleted cache entry from sync')
          break
      }
    } catch (err) {
      queryCacheMetrics.syncErrors.inc({ operation: 'handle_message' })
      logger.error({ err, message: messageStr }, 'Failed to handle cache sync message')
    }
  }

  /**
   * Start periodic backup timer with leader election
   */
  private startBackupTimer(): void {
    const intervalMs = config.cache.queryCache.backupIntervalMs

    this.backupInterval = setInterval(async () => {
      try {
        // When sync is enabled, use leader election to avoid duplicate work
        if (config.cache.queryCache.syncEnabled) {
          const isLeader = await this.acquireBackupLock()
          if (!isLeader) {
            logger.debug('Skipping backup - another instance is handling it')
            return
          }
        }

        await this.backupCache()
      } catch (err) {
        logger.error({ err }, 'Periodic cache backup failed')
      }
    }, intervalMs)

    logger.info(`Periodic cache backup enabled (interval: ${intervalMs / 1000}s)`)
  }

  /**
   * Acquire distributed lock for backup (leader election)
   */
  private async acquireBackupLock(): Promise<boolean> {
    try {
      const redis = await this.redisCache.getClient()
      const lockKey = `${config.cache.queryCache.backupKey}:lock`

      // Try to acquire lock with 5 minute expiry
      const acquired = await redis.set(lockKey, this.instanceId, {
        NX: true, // Only set if not exists
        EX: 300   // 5 minute expiry
      })

      if (acquired) {
        logger.debug({ instanceId: this.instanceId }, 'Acquired backup lock')
        return true
      }

      return false
    } catch (err) {
      logger.error({ err }, 'Failed to acquire backup lock')
      // On error, allow backup to proceed (fail-open)
      return true
    }
  }

  /**
   * Backup cache to Redis with chunked compression to avoid OOM
   */
  async backupCache(): Promise<void> {
    const endTimer = queryCacheMetrics.backupDuration.startTimer()

    try {
      const startTime = Date.now()
      const redis = await this.redisCache.getClient()
      const cacheKey = config.cache.queryCache.backupKey
      const chunkSize = config.cache.queryCache.chunkSize

      // Collect all cache entries
      const entries: Array<[string, any]> = []
      this.cache.forEach((value, key) => {
        entries.push([key, value])
      })

      if (entries.length === 0) {
        logger.info('Query cache is empty, skipping backup')
        endTimer()
        return
      }

      // Delete old chunks first (if metadata exists)
      const oldMeta = await redis.get(`${cacheKey}:meta`)
      if (oldMeta) {
        const { numChunks: oldNumChunks } = JSON.parse(oldMeta)
        const deletePromises = []
        for (let i = 0; i < oldNumChunks; i++) {
          deletePromises.push(redis.del(`${cacheKey}:chunk:${i}`))
        }
        await Promise.all(deletePromises)
      }

      // Split entries into chunks and store each one
      const numChunks = Math.ceil(entries.length / chunkSize)
      let totalCompressedSize = 0

      for (let i = 0; i < numChunks; i++) {
        const start = i * chunkSize
        const end = Math.min(start + chunkSize, entries.length)
        const chunk = entries.slice(start, end)

        // Compress chunk
        const json = JSON.stringify(chunk)
        const compressed = gzipSync(json)
        const base64 = compressed.toString('base64')

        // Store chunk
        await redis.set(`${cacheKey}:chunk:${i}`, base64, { EX: 86400 }) // 24h TTL
        totalCompressedSize += compressed.length
      }

      // Store metadata
      await redis.set(`${cacheKey}:meta`, JSON.stringify({
        totalEntries: entries.length,
        numChunks,
        chunkSize,
        timestamp: Date.now()
      }), { EX: 86400 })

      const duration = Date.now() - startTime

      // Update metrics
      queryCacheMetrics.backupsCompleted.inc()
      queryCacheMetrics.backupSize.set(totalCompressedSize)
      queryCacheMetrics.backupEntries.set(entries.length)
      endTimer()

      logger.info({
        entries: entries.length,
        chunks: numChunks,
        avgEntriesPerChunk: Math.floor(entries.length / numChunks),
        compressedSize: totalCompressedSize,
        duration
      }, 'Query cache backed up to Redis (chunked)')
    } catch (err) {
      endTimer()
      queryCacheMetrics.backupsFailed.inc()
      logger.error({ err }, 'Failed to backup query cache to Redis')
      throw err
    }
  }

  /**
   * Restore cache from Redis backup (chunked to avoid OOM)
   */
  async restoreCache(): Promise<void> {
    const endTimer = queryCacheMetrics.restoreDuration.startTimer()

    try {
      const startTime = Date.now()
      const redis = await this.redisCache.getClient()
      const cacheKey = config.cache.queryCache.backupKey

      // Check for chunked backup (new format)
      const metaData = await redis.get(`${cacheKey}:meta`)

      if (metaData) {
        // New chunked format
        await this.restoreChunkedBackup(redis, cacheKey, metaData, startTime, endTimer)
      } else {
        // Try legacy single-blob format (backward compatibility)
        await this.restoreLegacyBackup(redis, cacheKey, startTime, endTimer)
      }
    } catch (err) {
      endTimer()
      queryCacheMetrics.restoresFailed.inc()
      logger.warn({ err }, 'Failed to restore query cache, starting with empty cache')
    }
  }

  /**
   * Restore from new chunked backup format
   */
  private async restoreChunkedBackup(
    redis: any,
    cacheKey: string,
    metaData: string,
    startTime: number,
    endTimer: () => void
  ): Promise<void> {
    const meta = JSON.parse(metaData)
    const { numChunks, totalEntries } = meta

    logger.info({
      totalEntries,
      numChunks,
      avgChunkSize: Math.floor(totalEntries / numChunks)
    }, 'Starting chunked cache restoration')

    let restored = 0

    // Load and process chunks one at a time
    for (let i = 0; i < numChunks; i++) {
      const chunkKey = `${cacheKey}:chunk:${i}`
      const base64Data = await redis.get(chunkKey)

      if (!base64Data) {
        logger.warn({ chunk: i, numChunks }, 'Missing chunk during restore, skipping')
        continue
      }

      // Decompress and parse chunk
      const compressed = Buffer.from(base64Data, 'base64')
      const json = gunzipSync(compressed).toString('utf-8')
      const entries: Array<[string, any]> = JSON.parse(json)

      // Restore entries from this chunk
      for (const [key, value] of entries) {
        this.cache.set(key, value)
        restored++
      }

      // Allow GC between chunks and log progress
      if (i % 10 === 0 && i > 0) {
        await new Promise(resolve => setImmediate(resolve))
        logger.debug({
          progress: `${i}/${numChunks}`,
          restored
        }, 'Cache restoration progress')
      }
    }

    const duration = Date.now() - startTime

    // Update metrics
    queryCacheMetrics.restoresCompleted.inc()
    endTimer()

    logger.info({
      entries: restored,
      chunks: numChunks,
      duration
    }, 'Query cache restored from Redis (chunked)')
  }

  /**
   * Restore from legacy single-blob format (backward compatibility)
   */
  private async restoreLegacyBackup(
    redis: any,
    cacheKey: string,
    startTime: number,
    endTimer: () => void
  ): Promise<void> {
    const base64Data = await redis.get(cacheKey)

    if (!base64Data) {
      logger.info('No query cache backup found in Redis')
      endTimer()
      return
    }

    logger.warn('Restoring from legacy single-blob backup format - may cause OOM on large caches')

    // Convert from base64 and decompress
    const compressed = Buffer.from(base64Data, 'base64')
    const json = gunzipSync(compressed).toString('utf-8')
    const entries: Array<[string, any]> = JSON.parse(json)

    // Restore entries to cache
    let restored = 0
    for (const [key, value] of entries) {
      this.cache.set(key, value)
      restored++
    }

    const duration = Date.now() - startTime

    // Update metrics
    queryCacheMetrics.restoresCompleted.inc()
    endTimer()

    logger.info({
      entries: restored,
      compressedSize: compressed.length,
      decompressedSize: json.length,
      duration
    }, 'Query cache restored from Redis (legacy format)')

    // Note: We intentionally do NOT delete the backup after restore.
    // Multiple pods may start during rolling updates and all need to restore from the same backup.
    // The backup will be overwritten by the next scheduled backup or expire after 24h TTL.
  }
}
