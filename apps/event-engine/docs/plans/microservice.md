# Metric Event Watcher Microservice

## Overview
A high-performance microservice that consumes database events from Kafka (via Debezium/Postgres and Clickhouse) and processes them using workerpool for parallel metric updates.

@meta: Updated to use workerpool following the queue pattern from civitai-data-packer

## Architecture

### Core Components

#### 1. Kafka Consumer
- Connects to Kafka cluster
- Subscribes to relevant topics:
  - `postgres.public.*` (Debezium events from Postgres)
  - `clickhouse.*` (Events from Clickhouse Kafka Engine MVs)
- Manages consumer groups and offset commits
- Handles backpressure and rebalancing

#### 2. Event Router
- Parses incoming Kafka messages
- Identifies event type (create/update/delete)
- Routes to appropriate metric handlers based on:
  - Source system (pg/ch)
  - Table name
  - Operation type (c/u/d)

#### 3. Worker Pool (Workerpool)
```typescript
// Main process
import workerpool from 'workerpool'
import os from 'os'

const maxWorkers = process.env.WORKER_MAX_THREADS || os.cpus().length
const pool = workerpool.pool(__dirname + '/workers/metric-processor.js', {
  maxWorkers,
  workerType: 'thread'
})
```

#### 4. Metric Processors (Workers)
Each worker handles:
- Event validation
- Metric calculation
- Database queries (when additional data needed)
- Returns processed metric events

#### 5. Batch Aggregator
- Collects processed events from workers
- Groups by entity type and metric type
- Maintains two queues:
  - Clickhouse inserts (30s batch)
  - Meilisearch updates (5min batch)

#### 6. Storage Adapters
- **Clickhouse Adapter**: Batch inserts to `entityMetricEvents`
- **Redis Adapter**: Real-time cache updates (HINCRBY operations)
- **Postgres Adapter**: Fetches additional entity data when needed
- **Meilisearch Adapter**: Queues and batches index updates

## Event Processing Flow

```mermaid
graph TD
    K[Kafka Event] --> R[Event Router]
    R --> Q[Task Queue]
    Q --> P[Workerpool Workers]
    P --> MP[Main Process Callbacks]
    MP --> A[Batch Aggregator]
    A --> CH[Clickhouse Batch<br/>30s interval]
    A --> RD[Redis Cache<br/>Immediate]
    A --> MS[Meilisearch Queue<br/>5min interval]
```

## Metric Event Mappings

### Factory-Based Handler System

```typescript
// types/handlers.ts
interface DebeziumPayload<T = any> {
  before: T | null
  after: T | null
  op: 'c' | 'u' | 'd' | 'r' // create, update, delete, read
  ts_ms: number
  source: {
    table: string
    schema: string
    connector: string
  }
}

type EventHandlerContext<T = any> = {
  // Database query proxies (executed in main process)
  pg: {
    query: (sql: string, params?: any[]) => Promise<any>
    queryOne: (sql: string, params?: any[]) => Promise<any>
  }
  ch: {
    query: (sql: string) => Promise<any>
    insert: (table: string, data: any[]) => Promise<void>
  }

  // Event data
  old: T | null
  current: T | null
  operation: 'create' | 'update' | 'delete'

  // Actions (queued in main process)
  actions: {
    addMetricEvent: (args: {
      entityId: number
      entityType: string
      userId?: number
      metricType: string
      metricValue: number
      timestamp?: Date
    }) => void

    incMetricCache: (args: {
      entityId: number
      entityType: string
      metricType: string
      metricValue: number
    }) => void

    queueIndexUpdate: (args: {
      entityType: 'Model' | 'Post' | 'Image'
      entityId: number
    }) => void
  }
}

interface EventHandlerConfig<T = any> {
  events: Array<{
    tables: string[]
    operations: Array<'create' | 'update' | 'delete'>
  }>
  processor: (ctx: EventHandlerContext<T>) => Promise<void>
}

function createEventHandler<T = any>(config: EventHandlerConfig<T>) {
  return {
    canHandle: (event: DebeziumPayload) => {
      const tableName = `${event.source.connector}.${event.source.schema}.${event.source.table}`
      const operation = mapOperation(event.op)

      return config.events.some(e =>
        e.tables.includes(tableName) &&
        e.operations.includes(operation)
      )
    },
    process: config.processor
  }
}
```

### Example Event Handlers

```typescript
// handlers/userEngagement.ts
const userEngagementHandler = createEventHandler<UserEngagement>({
  events: [{
    tables: ['postgres.UserEngagement'],
    operations: ['create', 'delete']
  }],
  async processor(ctx) {
    const { current, old, operation, actions } = ctx

    // Helper functions scoped to this handler for DRY code
    const addUserMetric = (entityId: number, metricType: string, metricValue = 1) => {
      actions.addMetricEvent({
        entityId,
        entityType: 'User',
        metricType,
        metricValue,
        userId: current?.userId || old?.userId
      })
    }

    const incUserCache = (entityId: number, metricType: string, metricValue = 1) => {
      actions.incMetricCache({
        entityId,
        entityType: 'User',
        metricType,
        metricValue
      })
    }

    if (operation === 'create' && current) {
      // Following relationship created
      if (current.type === 'Follow') {
        addUserMetric(current.targetUserId, 'followerCount', 1)
        addUserMetric(current.userId, 'followingCount', 1)
        incUserCache(current.targetUserId, 'followerCount', 1)
      }

      // Hidden relationship created
      if (current.type === 'Hide') {
        addUserMetric(current.userId, 'hiddenCount', 1)
      }
    }

    if (operation === 'delete' && old) {
      // Reverse the metrics when deleted
      if (old.type === 'Follow') {
        addUserMetric(old.targetUserId, 'followerCount', -1)
        addUserMetric(old.userId, 'followingCount', -1)
        incUserCache(old.targetUserId, 'followerCount', -1)
      }
    }
  }
})

// handlers/resourceReview.ts
const resourceReviewHandler = createEventHandler<ResourceReview>({
  events: [{
    tables: ['postgres.ResourceReview'],
    operations: ['create', 'update', 'delete']
  }],
  async processor(ctx) {
    const { current, old, operation, actions, pg } = ctx

    // Calculate rating changes
    const oldRating = old?.rating || 0
    const newRating = current?.rating || 0
    const ratingDiff = newRating - oldRating

    if (operation === 'create' && current) {
      // Get model and version info
      const resource = await pg.queryOne(
        'SELECT modelId, modelVersionId FROM "ModelVersion" WHERE id = $1',
        [current.modelVersionId]
      )

      // Update model metrics
      actions.addMetricEvent({
        entityId: resource.modelId,
        entityType: 'Model',
        metricType: 'ratingCount',
        metricValue: 1,
        userId: current.userId
      })

      // Queue search index update
      actions.queueIndexUpdate({
        entityType: 'Model',
        entityId: resource.modelId
      })
    }

    if (operation === 'update' && ratingDiff !== 0) {
      // Handle rating changes
      const resource = await pg.queryOne(
        'SELECT modelId FROM "ModelVersion" WHERE id = $1',
        [current.modelVersionId]
      )

      actions.addMetricEvent({
        entityId: resource.modelId,
        entityType: 'Model',
        metricType: 'rating',
        metricValue: ratingDiff,
        userId: current.userId
      })
    }
  }
})

// handlers/outbox.ts
const outboxHandler = createEventHandler<OutboxEvent>({
  events: [{
    tables: ['postgres.outbox_events'],
    operations: ['create']
  }],
  async processor(ctx) {
    const { current, actions, pg } = ctx

    if (!current) return

    switch(current.event) {
      case 'NEW_POST_COVER':
        // Handle post cover image change
        actions.queueIndexUpdate({
          entityType: 'Post',
          entityId: current.entityId
        })
        break

      case 'MODEL_VERSION_PUBLISHED':
      case 'MODEL_VERSION_UNPUBLISHED':
        // Update user upload count
        const version = await pg.queryOne(
          'SELECT userId FROM "ModelVersion" WHERE id = $1',
          [current.entityId]
        )

        const metricValue = current.event === 'MODEL_VERSION_PUBLISHED' ? 1 : -1
        actions.addMetricEvent({
          entityId: version.userId,
          entityType: 'User',
          metricType: 'uploadCount',
          metricValue
        })
        break
    }

    // Mark outbox event as processed
    await pg.query(
      'DELETE FROM outbox_events WHERE id = $1',
      [current.id]
    )
  }
})

// handlers/index.ts
export const eventHandlers = {
  userEngagement: userEngagementHandler,
  resourceReview: resourceReviewHandler,
  outbox: outboxHandler,
  // ... all other handlers
}
```

@meta: Updated handler system to use factory pattern with proper separation between worker processing and main process database operations via proxy functions

## Worker Implementation

### Worker Module
```typescript
// workers/metric-processor.ts
import workerpool from 'workerpool'
import { eventHandlers } from '../handlers'
import type { EventHandlerContext, DebeziumPayload } from '../types'

// Process event with appropriate handler
async function processEvent(event: DebeziumPayload, handlerName: string) {
  const handler = eventHandlers[handlerName]
  @meta: Changed to use handler names instead of indices

  // Create context with proxy functions that call back to main process
  const context: EventHandlerContext = {
    // Database proxies - these call back to main process
    pg: {
      query: (sql: string, params?: any[]) =>
        workerpool.workerEmit('pg:query', { sql, params }),
      queryOne: (sql: string, params?: any[]) =>
        workerpool.workerEmit('pg:queryOne', { sql, params })
    },
    ch: {
      query: (sql: string) =>
        workerpool.workerEmit('ch:query', { sql }),
      insert: (table: string, data: any[]) =>
        workerpool.workerEmit('ch:insert', { table, data })
    },

    // Event data
    old: event.before,
    current: event.after,
    operation: mapOperation(event.op),

    // Actions - these queue operations in main process
    actions: {
      addMetricEvent: (args) =>
        workerpool.workerEmit('action:addMetricEvent', args),
      incMetricCache: (args) =>
        workerpool.workerEmit('action:incMetricCache', args),
      queueIndexUpdate: (args) =>
        workerpool.workerEmit('action:queueIndexUpdate', args)
    }
  }

  // Process with handler
  await handler.process(context)
}

function mapOperation(op: string): 'create' | 'update' | 'delete' {
  switch(op) {
    case 'c': return 'create'
    case 'u': return 'update'
    case 'd': return 'delete'
    default: throw new Error(`Unknown operation: ${op}`)
  }
}

// Register worker methods
workerpool.worker({
  processEvent
})
```

### Main Process Integration
```typescript
// main/workerManager.ts
import workerpool from 'workerpool'
import { Pool } from 'pg'
import { ClickHouseClient } from '@clickhouse/client'
import { eventHandlers } from '../handlers'
import { addTask, getTask, completeTask } from './taskQueue'

const pgPool = new Pool(/* config */)
const chClient = new ClickHouseClient(/* config */)
const pool = workerpool.pool(__dirname + '/../workers/metric-processor.js', {
  maxWorkers: process.env.MAX_WORKERS || os.cpus().length,
  workerType: 'thread'
})

// Process task from queue
function processTask(task: QueuedTask) {
  const { event, handlerName } = task

  pool.exec('processEvent', [event, handlerName], {
    // Handle worker callbacks
    on: async (eventName: string, data: any) => {
      switch(eventName) {
        // Database proxy callbacks
        case 'pg:query':
          return await pgPool.query(data.sql, data.params)
        case 'pg:queryOne':
          const result = await pgPool.query(data.sql, data.params)
          return result.rows[0]
        case 'ch:query':
          return await chClient.query({ query: data.sql })
        case 'ch:insert':
          return await chClient.insert({
            table: data.table,
            values: data.data,
            format: 'JSONEachRow'
          })

        // Action callbacks
        case 'action:addMetricEvent':
          metricEventBatcher.add(data)
          break
        case 'action:incMetricCache':
          await redisCache.increment(data)
          break
        case 'action:queueIndexUpdate':
          indexUpdateQueue.add(data)
          break
      }
    }
  })
  .then(() => {
    completeTask(task)
    startNextTask() // Process next item in queue
  })
  .catch((error) => {
    console.error(`Error processing task:`, error)
    // Handle error - maybe requeue with retry limit
  })
}

// Queue management
function startNextTask() {
  const task = getTask()
  if (task) {
    processTask(task)
  } else if (isQueueEmpty()) {
    // Check if we should shutdown
    if (shouldShutdown) {
      pool.terminate()
      process.exit(0)
    }
  }
}

// Kafka event handler
export function handleKafkaEvent(event: DebeziumPayload) {
  // Find matching handlers
  Object.entries(eventHandlers).forEach(([name, handler]) => {
    if (handler.canHandle(event)) {
      addTask({
        event,
        handlerName: name,
        retries: 0
      })
    }
  })
}

// Start workers
export function startWorkers() {
  const numWorkers = pool.maxWorkers
  for (let i = 0; i < numWorkers; i++) {
    startNextTask()
  }
}
```

@meta: Implemented worker-to-main-process communication pattern using workerpool's workerEmit for database queries and action callbacks. This ensures database connections remain in the main process pool while workers handle the processing logic.

## Batch Processing

### Clickhouse Batch Insert (30s)
```javascript
class ClickhouseBatcher {
  constructor() {
    this.queue = []
    this.interval = 30000 // 30 seconds
  }

  add(event) {
    this.queue.push(event)
  }

  async flush() {
    if (this.queue.length === 0) return

    const batch = this.queue.splice(0)
    await clickhouse.insert({
      table: 'entityMetricEvents',
      values: batch,
      format: 'JSONEachRow'
    })
  }
}
```

### Meilisearch Index Updates (5min)
```javascript
class MeilisearchBatcher {
  constructor() {
    this.updates = new Map() // entityType -> Map(entityId -> metrics)
    this.interval = 300000 // 5 minutes
  }

  queue(entityType, entityId, metrics) {
    if (!this.updates.has(entityType)) {
      this.updates.set(entityType, new Map())
    }

    const entities = this.updates.get(entityType)
    const current = entities.get(entityId) || {}
    entities.set(entityId, { ...current, ...metrics })
  }

  async flush() {
    for (const [entityType, entities] of this.updates) {
      const documents = Array.from(entities.entries()).map(([id, metrics]) => ({
        id,
        ...metrics
      }))

      await meilisearch
        .index(`${entityType}_metrics`)
        .updateDocuments(documents)
    }

    this.updates.clear()
  }
}
```

## Configuration

### Environment Variables
```env
# Database Configuration (already in .env.example)
DATABASE_URL=postgresql://user:pass@host:port/database

# Clickhouse Configuration (already in .env.example)
CLICKHOUSE_URL=https://user:pass@host:port

# Redis Configuration (already in .env.example)
REDIS_URL=redis://user:pass@host:port

# Kafka Configuration (already in .env.example)
KAFKA_BROKERS=localhost:9092
KAFKA_CONSUMER_GROUP=metric-event-watcher

# Debezium Configuration (already in .env.example)
DEBEZIUM_CONNECT_URL=http://localhost:8083

# Application Configuration (already in .env.example)
NODE_ENV=development
LOG_LEVEL=info
BATCH_INSERT_INTERVAL=30  # 30 seconds
INDEX_UPDATE_INTERVAL_MS=300  # 5 minutes
WORKER_POOL_SIZE=10

# Meilisearch Index URLs (new - needed for each index)
MEILISEARCH_IMAGE_INDEX_URL=http://localhost:7700/indexes/images
MEILISEARCH_MODEL_INDEX_URL=http://localhost:7700/indexes/models
MEILISEARCH_POST_INDEX_URL=http://localhost:7700/indexes/posts
MEILISEARCH_API_KEY=
```

@meta: Updated to match existing configuration from .env.example and added Meilisearch index URLs

## Error Handling

### Retry Strategy
- Kafka: Auto-retry with exponential backoff
- Database connections: Circuit breaker pattern
- Worker failures: Requeue with retry limit
- Dead letter queue for persistent failures

### Monitoring
- Worker pool utilization metrics
- Event processing latency
- Batch insert success rates
- Error rates by event type
- Queue depths (Clickhouse/Meilisearch)

## Deployment Considerations

### Scaling
- Horizontal scaling via multiple consumer instances
- Kafka partition assignment for load distribution
- Worker pool size based on CPU cores
- Memory limits for worker recycling

### Health Checks
- Kafka connection status
- Database connectivity (PG, CH, Redis)
- Worker pool availability
- Batch processing intervals
- Memory usage monitoring

## Development Roadmap

### Phase 1: Core Infrastructure
- [ ] Kafka consumer setup
- [ ] Basic event routing
- [ ] Workerpool integration with queue pattern
- [ ] Factory-based event handlers
- [ ] Database proxy functions

### Phase 2: Storage Integration
- [ ] Clickhouse batch inserts
- [ ] Redis cache updates
- [ ] Postgres data fetching
- [ ] Error handling

### Phase 3: Advanced Processing
- [ ] Complex metric calculations
- [ ] Meilisearch integration
- [ ] Performance optimization
- [ ] Monitoring/observability

### Phase 4: Production Ready
- [ ] Comprehensive testing
- [ ] Documentation
- [ ] Deployment scripts
- [ ] Performance tuning