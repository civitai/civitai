# Common Services & Utilities

This directory contains shared services, caches, feeds, and utilities used throughout the metric event watcher application and feed systems.

## Directory Structure

```
common/
├── caches/              # Cache implementations
│   ├── base.ts          # Cache factory & core logic
│   ├── index.ts         # Cache registry
│   ├── userData.cache.ts # Example cache
├── feeds/               # Feed implementations
│   ├── base.ts          # Feed factory & core logic
│   ├── types.ts         # Feed type definitions
│   ├── index.ts         # Feed registry
│   └── image.feed.ts    # Example Feed
├── services/            # Core services
│   ├── cache.ts         # Centralized cache service
│   ├── metrics.ts       # Metric fetching service
│   ├── outbox.ts        # Outbox pattern service
│   └── database/        # Database providers
├── types/               # Type definitions
│   ├── metric-types.ts
│   ├── database.ts
│   └── meilisearch/
└── utils/               # Utility functions
    ├── basic.ts
    ├── cache-keys.ts
    ├── async-utils.ts
    └── meilisearch-helpers.ts
```

## Services

### CacheService (`services/cache.ts`)

Centralized service for accessing all caches with typed access and automatic type inference.

**Key Features:**
- Type-safe cache access with automatic inference from cache name
- Centralized context management (Redis, PostgreSQL, ClickHouse)
- Unified interface for fetch, bust, and refresh operations
- Optional MessagePack compression support

**Methods:**
- `fetch<K>(name: K, ids: number[])` - Fetch items from cache by name
- `bust<K>(name: K, ids: number | number[], options?)` - Invalidate cache entries
- `refresh<K>(name: K, ids: number | number[])` - Refresh cache entries with fresh data

**Usage Example:**
```typescript
const cacheService = new CacheService(redis, pg, ch, msgpackPacker);

// Fetch user data - return type is automatically inferred
const users = await cacheService.fetch('userData', [1, 2, 3]);
// Returns: Record<number, UserCacheData>

// Bust cache for updated users
await cacheService.bust('userData', [1, 2, 3]);

// Refresh cache with fresh data from database
await cacheService.refresh('modelData', [100, 101]);
```

### MetricService (`services/metrics.ts`)

Handles fetching and caching of entity metrics from ClickHouse with Redis caching layer.

**Key Features:**
- Read-through cache with 24-hour TTL for found metrics, 5-minute TTL for misses
- Cache stampede prevention using distributed locks
- Batch fetching support for efficient database queries
- TTL sliding for hot cache entries (10% chance on access)
- Type-safe metric fetching with automatic inference based on entity type

**Methods:**
- `fetch<T>(entityType: T, ids: number[])` - Fetch metrics for multiple entities with caching
- `fetchTimeframes<T>(entityType: T, ids: number[])` - Fetch metrics broken down by time periods (Day, Week, Month, Year, AllTime)
- `bustCache<T>(entityType: T, ids: number | number[])` - Invalidate cached metrics for specific entities

**Usage Example:**
```typescript
const metricService = new MetricService(clickhouse, redis);

// Fetch article metrics
const articleMetrics = await metricService.fetch('Article', [1, 2, 3]);
// Returns: Record<number, ArticleMetrics>

// Fetch metrics with timeframes
const timeframeMetrics = await metricService.fetchTimeframes('Image', [4, 5, 6]);
// Returns: Record<number, Record<Timeframes, ImageMetrics>>

// Bust cache for updated entities
await metricService.bustCache('Model', [7, 8]);
```

### OutboxService (`services/outbox.ts`)

Manages outbox pattern for reliable event processing and entity state change tracking.

**Key Features:**
- Tracks entity lifecycle events (PUBLISHED, UNPUBLISHED, DELETED, UPDATED)
- Supports multiple entity types (Article, Image, Model, Post, ModelVersion)
- Simple PostgreSQL-based persistence

**Methods:**
- `add(record: OutboxRecord)` - Add a new outbox event
- `delete(id: number)` - Remove a processed outbox record

**Usage Example:**
```typescript
const outboxService = new OutboxService(pgClient);

// Add an event to the outbox
await outboxService.add({
    event: OutboxEvent.PUBLISHED,
    entityType: 'Article',
    entityId: 123
});

// Delete processed event
await outboxService.delete(recordId);
```

## Cache System

The cache system (`caches/`) provides a pattern for creating high-performance, distributed caches with advanced features like stale-while-revalidate, stampede prevention, and debounce handling.

### Cache Architecture

**Pattern:** Each cache is created using `createCache()` factory from `caches/base.ts` and exported from `caches/index.ts`

**Cache Features:**
- **Distributed locking** - Prevents cache stampede on popular keys
- **Stale-while-revalidate** - Serve stale data while fetching fresh data in background
- **TTL sliding** - Hot entries automatically get TTL extended (10% chance on access)
- **Debounce handling** - Prevent refetch during write propagation period
- **Not-found caching** - Cache misses with shorter TTL to reduce database load
- **Batch operations** - Efficient bulk fetch/bust/refresh operations

### How Caches Work

1. **Fetch Flow:**
   - Check Redis for cached values (batched, 200 keys at a time)
   - For cache hits: Return immediately (or mark for revalidation if stale)
   - For cache misses: Acquire distributed lock, fetch from database, cache results
   - If another process holds lock: Wait briefly and retry fetching from cache

2. **Bust Flow:**
   - Set debounce marker in Redis with short TTL (default 10s)
   - Next fetch will skip cache and refetch from database
   - Prevents reading from read replicas during propagation delay

3. **Refresh Flow:**
   - Fetch fresh data from database
   - Update cache with new values
   - Delete entries that no longer exist

### Creating a New Cache

**Step 1:** Create cache file in `caches/` directory (e.g., `userData.cache.ts`)

```typescript
import { createCache, CacheContext } from './base';

export type UserCacheData = {
  userId: number;      // Must match idKey below
  username: string;
  image?: string;
  deletedAt?: Date | null;
};

export const userData = createCache<UserCacheData>({
  redisKey: 'user:data',  // Redis key prefix
  idKey: 'userId',        // Property to use as ID

  // Fetch function returns array of items
  async fetch({ pg }: CacheContext, ids: number[]) {
    const users = await pg.query<UserCacheData>(
      `SELECT
        id as "userId",
        username,
        image,
        "deletedAt"
       FROM "User"
       WHERE id = ANY($1)`,
      [ids]
    );
    return users;
  },

  // Optional configuration
  ttl: 60 * 60 * 24,              // 24 hours (default)
  debounceTime: 10,                // 10 seconds (default)
  cacheNotFound: true,             // Cache misses (default: true)
  staleWhileRevalidate: true,      // Background refresh (default: true)

  // Optional: Skip caching for specific data
  dontCacheFn: (data) => data.deletedAt !== null,
});
```

**Step 2:** Export cache from `caches/index.ts`

```typescript
export { userData } from './userData.cache';
export type { UserCacheData } from './userData.cache';
```

**Step 3:** Use cache via CacheService

```typescript
// Via CacheService (recommended)
const users = await cacheService.fetch('userData', [1, 2, 3]);

// Or directly in feed context
const users = await ctx.cache.fetch('userData', [1, 2, 3]);
```

### Cache Configuration Options

```typescript
{
  redisKey: string;           // Redis key prefix (e.g., 'user:data')
  idKey: keyof T;             // Property name used as the ID
  fetch: (ctx, ids) => T[];   // Function to fetch data from database
  ttl?: number;               // Cache TTL in seconds (default: 24 hours)
  debounceTime?: number;      // Write propagation delay (default: 10s)
  cacheNotFound?: boolean;    // Cache "not found" results (default: true)
  dontCacheFn?: (data) => boolean;  // Skip caching certain records
  staleWhileRevalidate?: boolean;   // Background refresh (default: true)
}
```

## Feed System

The feed system (`feeds/`) provides a pattern for creating Meilisearch-backed feeds with integrated metrics, caching, and population logic.

### Feed Architecture

**Pattern:** Each feed is created using `createFeed()` factory from `feeds/base.ts`

**Feed Features:**
- **Schema-driven** - Type-safe documents with automatic Meilisearch configuration
- **Integrated metrics** - Built-in metric fetching from ClickHouse
- **Cache integration** - Access to all caches for data population
- **Batched operations** - Efficient batch upsert with configurable concurrency
- **Type inference** - Full type safety from schema to API response
- **Pagination support** - Cursor-based pagination built into queries

### Feed Methods

Each feed provides these methods:

- `upsert(ids: number[], type?: 'full' | 'metrics')` - Insert/update documents in Meilisearch
- `delete(ids: number[])` - Remove documents from Meilisearch
- `query(input: TInput)` - Query documents with filters and pagination
- `populate(docs: TDocument[])` - Enrich documents with related data
- `populatedQuery(input: TInput)` - Combined query + populate

### Creating a New Feed

**Step 1:** Create feed file in `feeds/` directory (e.g., `image.feed.ts`)

```typescript
import { createFeed } from './base';
import type { ImageMetrics } from '../types/metric-types';

// Define schema for Meilisearch
const schema = {
  id: { type: 'number' as const, primary: true, filterable: true },
  userId: { type: 'number' as const, filterable: true },
  nsfw: { type: 'boolean' as const, filterable: true },
  createdAt: { type: 'Date' as const, sortable: true },
  heartCount: { type: 'number' as const, sortable: true },
  likeCount: { type: 'number' as const, sortable: true },
} as const;

// Document stored in Meilisearch
type ImageDocument = {
  id: number;
  userId: number;
  nsfw: boolean;
  createdAt: Date;
  heartCount: number;
  likeCount: number;
};

// Query input (filters)
type ImageQueryInput = {
  nsfw?: boolean;
  userId?: number;
};

// Populated document returned to API
type PopulatedImage = ImageDocument & {
  url: string;
  username: string;
};

export const ImageFeed = createFeed({
  entityType: 'Image' as const,
  name: 'images',
  connection: {
    host: process.env.MEILISEARCH_IMAGE_INDEX_URL!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  },
  schema,

  // Create documents from entity IDs
  async createDocuments(ctx, ids, type = 'full') {
    // Fetch base data
    const images = await ctx.pg.query<Omit<ImageDocument, 'heartCount' | 'likeCount'>>(
      `SELECT id, "userId", nsfw, "createdAt"
       FROM "Image" WHERE id = ANY($1)`,
      [ids]
    );

    // Fetch metrics
    const metrics = await ctx.metric.fetch(images.map(i => i.id));

    // Combine
    return images.map((img): ImageDocument => ({
      ...img,
      heartCount: metrics[img.id]?.Heart ?? 0,
      likeCount: metrics[img.id]?.Like ?? 0,
    }));
  },

  // Query documents from Meilisearch
  async queryDocuments(ctx, input: ImageQueryInput): Promise<ImageDocument[]> {
    const { limit, cursor } = ctx.pagination;
    const { nsfw, userId } = input;

    // Build filters
    const filters: string[] = [];
    if (nsfw !== undefined) filters.push(`nsfw = ${nsfw}`);
    if (userId) filters.push(`userId = ${userId}`);

    // Handle cursor pagination
    let cursorFilter = '';
    if (cursor) {
      const [createdAt, id] = cursor.split(':');
      cursorFilter = `createdAt < ${createdAt} OR (createdAt = ${createdAt} AND id < ${id})`;
      if (filters.length) cursorFilter = ` AND (${cursorFilter})`;
    }

    // Search
    const result = await ctx.index.search<ImageDocument>(null, {
      filter: filters.join(' AND ') + cursorFilter,
      sort: ['createdAt:desc', 'id:desc'],
      limit,
    });

    return result.hits;
  },

  // Populate documents with related data
  async populateDocuments(ctx, documents) {
    const userIds = [...new Set(documents.map(d => d.userId))];
    const users = await ctx.cache.fetch('userData', userIds);

    return documents.map((doc): PopulatedImage => ({
      ...doc,
      url: `https://image.civitai.com/${doc.id}`,
      username: users[doc.userId]?.username ?? 'unknown',
    }));
  },

  // Optional: Advanced options
  options: {
    fetchBatchSize: 1000,      // Batch size for createDocuments
    upsertBatchSize: 100000,   // Batch size for Meilisearch updates
    createConcurrency: 2,      // Concurrent createDocuments calls
  },
});
```

**Step 2:** Export feed from `feeds/index.ts`

```typescript
export { ImageFeed } from './image.feed';
```

**Step 3:** Use feed in application

```typescript
// Initialize feed
const imageFeed = new ImageFeed(meilisearch, ch, pg, metricService, cacheService);

// Upsert documents
await imageFeed.upsert([1, 2, 3], 'full');

// Query documents
const images = await imageFeed.query({
  nsfw: false,
  userId: 123,
  limit: 20,
  cursor: '2024-01-15T10:00:00.000Z:456'
});

// Query and populate in one call
const populatedImages = await imageFeed.populatedQuery({
  nsfw: false,
  limit: 20
});
```

### Feed Schema Field Types

```typescript
{
  type: 'string' | 'number' | 'Date' | 'boolean' | 'array';
  arrayType?: 'string' | 'number' | 'boolean';  // For array types
  sortable?: boolean;      // Make field sortable in Meilisearch
  filterable?: boolean;    // Make field filterable in Meilisearch
  primary?: boolean;       // Mark as primary key
}
```

### Feed Context

The `ctx` parameter provides access to:

```typescript
{
  pg: { query<T>(sql, params?) => Promise<T[]> },      // PostgreSQL
  ch: { query<T>(sql, params?) => Promise<T[]> },      // ClickHouse
  cache: { fetch(name, ids) => Promise<Record<...>> }, // Cache access
  metric: { fetch(ids) => Promise<Record<...>> },      // Metric access
  index: IMeilisearchIndex,                            // Meilisearch index
  pagination: { limit: number, cursor?: string },      // Pagination params
}
```

## Utilities

### Basic Utils (`utils/basic.ts`)
- `chunk<T>(array: T[], size: number)` - Split array into chunks
- `sleep(ms: number)` - Async sleep utility

### Async Utils (`utils/async-utils.ts`)
- `createAsyncBatcher<T>(batchSize, flushFn)` - Batching helper for async operations
- `runWithConcurrency<T>(tasks[], concurrency)` - Run tasks with concurrency limit

### Cache Keys (`utils/cache-keys.ts`)
- Consistent Redis key generation across services

### Meilisearch Helpers (`utils/meilisearch-helpers.ts`)
- `getMeilisearchFeed(config)` - Initialize Meilisearch index for feeds

## Dependencies

All services and utilities rely on:
- `utils/query-utils.ts` - Database client wrappers with helper methods
- `types/metric-types.ts` - Entity and metric type definitions
- `types/package-stubs.ts` - External package interface definitions
- `utils/cache-keys.ts` - Consistent Redis key generation
- `utils/basic.ts` - Basic utility functions (chunk, sleep, etc.)
