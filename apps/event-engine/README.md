# Metric Event Watcher

A high-performance microservice that consumes database events from Kafka (via Debezium/PostgreSQL and ClickHouse) and processes them using workerpool for parallel metric updates.

## Key Features

- **Factory-based Handler System**: DRY patterns for creating event handlers
- **Worker Pool Processing**: Parallel event processing with `workerpool`
- **Batch Operations**: Efficient batching for ClickHouse inserts and Meilisearch updates
- **Real-time Cache Updates**: Immediate Redis cache updates for metrics
- **Real-time Signals**: Broadcasts metric deltas via Signals API for live UI updates
- **Automatic Retries**: Exponential backoff for failed events
- **Type-safe**: Full TypeScript implementation

## Architecture

### Core Components

- **Kafka + Zookeeper**: Message broker for event streaming
- **Debezium**: CDC (Change Data Capture) for PostgreSQL
- **Worker Pool**: Multi-threaded processing with `workerpool`
- **Batch Processing**:
  - ClickHouse: 30-second batched metric event inserts
  - Meilisearch: 5-minute batched index updates
  - Redis: Real-time cache increments
  - Signals: Real-time metric delta broadcasts

### Handler Patterns

- `createEventHandler()` - Base factory for all handlers
- `createCrudProcessor()` - Handles common CRUD patterns
- `createReactionHandler()` - Specialized for reaction events (likes, hearts, etc.)
- `createRelationshipHandler()` - For follow/hide relationships

## Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Access to existing PostgreSQL, ClickHouse, and Redis instances

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and configure your settings:

```bash
cp .env.example .env
```

### 3. Start Infrastructure

Start Kafka, Zookeeper, and Debezium:

```bash
docker-compose up -d
```

**Note for SSH Tunnels**: If you're using an SSH tunnel to connect to your database (e.g., `localhost:25061`):
- The setup will automatically replace `localhost` with `host.docker.internal`
- This allows Debezium (in Docker) to connect to your host machine
- Linux users: The `extra_hosts` configuration is already included in docker-compose.yml

### 4. Setup PostgreSQL Replication

#### For DigitalOcean Managed Databases:

```bash
npm run setup:digitalocean
```

This will verify your DigitalOcean database is configured correctly. You may need to:
1. Enable logical replication in your DigitalOcean dashboard
2. Set `wal_level = logical` in PostgreSQL Configuration
3. Ensure adequate `max_replication_slots` and `max_wal_senders`

#### For Self-Managed Databases:

```bash
npm run setup:pg-replication
```

Note: Ensure PostgreSQL has these settings:
- `wal_level = logical`
- `max_replication_slots = 4`
- `max_wal_senders = 4`

### 5. Configure Debezium Connector

Create the Debezium connector for PostgreSQL CDC:

```bash
npm run setup:debezium
```

**Note**: If your PostgreSQL is running on `localhost` (e.g., via SSH tunnel to DigitalOcean), the script automatically maps `localhost` to `host.docker.internal` so Debezium running in Docker can connect to it.

### 6. Setup ClickHouse Kafka Tables

Create Kafka engine tables and materialized views in ClickHouse:

```bash
npm run setup:clickhouse
```

## Running

### Development Mode

```bash
npm run dev
```

### Test Consumer

To verify Kafka events are flowing:

```bash
npm run consumer:test
```

### Production

```bash
npm run build
npm start
```

## Monitoring

- **Kafka UI**: http://localhost:8080
- **Debezium API**: http://localhost:8083
- **Health Check**: http://localhost:3000/health
- **Prometheus Metrics**: http://localhost:3000/metrics

### Health Check Endpoints

The service exposes several HTTP endpoints for monitoring and health checks:

- `GET /health` - Full health check (Kafka, Debezium, Database, Redis)
  - Returns 200 if healthy, 503 if unhealthy
- `GET /ready` - Readiness probe (stricter than liveness)
  - Only returns 200 if all services are healthy
- `GET /live` - Liveness probe
  - Simple check that the process is running
- `GET /metrics` - Prometheus metrics endpoint
  - Returns metrics in Prometheus text format for scraping

**Kubernetes Configuration:**

```yaml
livenessProbe:
  httpGet:
    path: /live
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 5
```

### Prometheus Metrics

The service exposes comprehensive Prometheus metrics at `/metrics`. All metrics are prefixed with `mew_` (metric-event-watcher).

#### Event Processing Metrics

- `mew_events_processed_total{handler, status}` - Total events processed (counter)
  - Labels: `handler` (handler name), `status` (success/failed)
- `mew_events_retried_total{handler, attempt}` - Total events retried (counter)
  - Labels: `handler`, `attempt` (retry attempt number)
- `mew_events_failed_total{handler}` - Total events failed after max retries (counter)
- `mew_active_tasks` - Currently active event processing tasks (gauge)
- `mew_pending_tasks` - Tasks waiting to be processed (gauge)
- `mew_retry_queue_size` - Events in the retry queue (gauge)
- `mew_event_processing_duration_seconds{handler}` - Event processing duration (histogram)
  - Buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5]

#### Metric Batch Metrics

- `mew_metric_batches_flushed_total` - Total metric batches flushed to ClickHouse (counter)
- `mew_metric_batches_failed_total` - Total failed metric batch flushes (counter)
- `mew_metric_events_batched_total` - Total metric events batched (counter)
- `mew_metric_batch_queue_size` - Current events in metric batch queue (gauge)
- `mew_metric_batch_flush_duration_seconds` - Duration of batch flush operations (histogram)
  - Buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]

#### Index Update Metrics

- `mew_index_batches_flushed_total{entity_type}` - Total index batches flushed (counter)
- `mew_index_batches_failed_total` - Total failed index batches (counter)
- `mew_index_updates_processed_total{entity_type}` - Total index updates processed (counter)
- `mew_index_queue_size{entity_type}` - Current entities in index update queue (gauge)
- `mew_index_batch_flush_duration_seconds{entity_type}` - Duration of index flush operations (histogram)
  - Buckets: [0.1, 0.5, 1, 2, 5, 10]

#### Signals Metrics

- `mew_signals_sent_total` - Total metric delta signals sent (counter)
- `mew_signals_failed_total` - Total failed metric delta signals (counter)

#### Redis Cache Metrics

- `mew_redis_cache_updates_total{operation}` - Total Redis cache updates (counter)
  - Labels: `operation` (increment, etc.)
- `mew_redis_cache_errors_total{operation}` - Total Redis cache errors (counter)

#### Default Node.js Metrics

The service also exposes default Node.js metrics:
- `mew_process_cpu_user_seconds_total` - User CPU time
- `mew_process_cpu_system_seconds_total` - System CPU time
- `mew_process_resident_memory_bytes` - Resident memory size
- `mew_nodejs_heap_size_total_bytes` - Total heap size
- `mew_nodejs_heap_size_used_bytes` - Used heap size
- And many more...

**Prometheus Configuration:**

```yaml
scrape_configs:
  - job_name: 'metric-event-watcher'
    static_configs:
      - targets: ['metric-event-watcher:3000']
    scrape_interval: 15s
    scrape_timeout: 10s
```

## Scripts

### Setup Scripts
- `npm run setup:digitalocean` - Verify DigitalOcean managed database configuration
- `npm run setup:debezium` - Configure Debezium connector for CDC
- `npm run setup:clickhouse` - Setup ClickHouse Kafka engine tables

### Teardown Scripts
- `npm run teardown:pg-replication` - Remove replication slots, user, and publications

### Development Scripts
- `npm run dev` - Run in development mode with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm run start` - Run production build
- `npm run test` - Run tests
- `npm run lint` - Run ESLint
- `npm run typecheck` - Type check without building
- `npm run consumer:test` - Test Kafka consumer without processing

## Environment Variables

```bash
# Required
DATABASE_URL=postgresql://user:pass@host:port/database
CLICKHOUSE_URL=https://user:pass@host:port
REDIS_URL=redis://user:pass@host:port
KAFKA_BROKERS=localhost:9092

# Optional
WORKER_POOL_SIZE=10  # Defaults to 10
BATCH_INSERT_INTERVAL=30  # ClickHouse batch interval (seconds)
INDEX_UPDATE_INTERVAL=300  # Meilisearch update interval (seconds)
HEALTH_CHECK_PORT=3000  # Health check server port

# Meilisearch (if using search index updates)
MEILISEARCH_IMAGE_INDEX_URL=http://localhost:7700
MEILISEARCH_MODEL_INDEX_URL=http://localhost:7700
MEILISEARCH_POST_INDEX_URL=http://localhost:7700
MEILISEARCH_API_KEY=your-api-key

# Signals API (optional - for real-time metric broadcasts)
SIGNALS_API_URL=http://signals-service.internal
SIGNALS_ENABLED=true
```

## Cleanup After Testing

To prevent WAL accumulation and clean up resources after testing:

```bash
npm run teardown:pg-replication  # Then clean PostgreSQL

# Stop Docker containers
docker-compose down

# Remove Docker volumes (optional - will delete all data)
docker-compose down -v
```

**Important**: Always run teardown scripts before stopping PostgreSQL to prevent WAL buildup from orphaned replication slots.

## Event Flow

1. Database changes occur in PostgreSQL
2. Debezium captures changes and publishes to Kafka
3. Consumer reads events from Kafka topics
4. Event router finds matching handlers
5. Tasks queued and distributed to worker pool
6. Workers process events with database proxy functions
7. Updates are batched and written to:
   - ClickHouse (entity metric events) - 30s batches
   - Redis (metric caches) - immediate
   - Meilisearch (search indexes) - 5min batches
   - Signals API (metric deltas) - immediate broadcast

## Adding New Handlers

### Simple Handler Example

```typescript
import { createEventHandler } from './base'

export const myHandler = createEventHandler({
  name: 'myHandler',
  tables: ['MyTable'],
  operations: ['create', 'delete'],
  processor: async (ctx) => {
    const { current, old, operation, actions } = ctx

    if (operation === 'create' && current) {
      actions.addMetricEvent({
        entityId: current.id,
        entityType: 'MyEntity',
        metricType: 'count',
        metricValue: 1
      })
    }
  }
})
```

### Using CRUD Processor

```typescript
export const handler = createEventHandler({
  name: 'handler',
  tables: ['Table'],
  operations: ['create', 'update', 'delete'],
  processor: createCrudProcessor({
    entityType: 'Entity',
    onCreate: async (current, helpers) => {
      helpers.addAndInc(current.id, 'count', 1)
    },
    onDelete: async (old, helpers) => {
      helpers.addAndInc(old.id, 'count', -1)
    }
  })
})
```

### Register Handler

Add to `src/handlers/index.ts`:

```typescript
export const eventHandlers = {
  // ... existing handlers
  myHandler: myHandler
}
```

## Monitored Tables

### PostgreSQL (via Debezium)
- UserEngagement
- ImageReaction
- ModelVersion
- ResourceReview
- CollectionItem
- Comments
- Tags relationships
- And more...

### ClickHouse
- modelVersionEvents (downloads)
- orchestration.jobs (generations)
- buzz_resource_compensation (earnings)
- entityMetricEvents (all aggregated metrics)

## Supported Metrics

### User Metrics
- `followingCount`, `followerCount`
- `uploadCount`, `reviewCount`
- `hiddenCount`, `reactionCount`

### Model/ModelVersion Metrics
- `rating`, `ratingCount`
- `downloadCount`, `favoriteCount`
- `commentCount`, `collectedCount`
- `imageCount`, `generationCount`
- `thumbsUpCount`, `thumbsDownCount`
- `tippedCount`, `tippedAmountCount`

### Post/Image Metrics
- `likeCount`, `dislikeCount`
- `laughCount`, `cryCount`, `heartCount`
- `commentCount`, `collectedCount`
- `tippedCount`, `viewCount`

### Collection Metrics
- `followerCount`, `itemCount`, `contributorCount`

### Tag Metrics
- `modelCount`, `imageCount`, `postCount`
- `hiddenCount`, `followerCount`