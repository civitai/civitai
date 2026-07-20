Please review the document below, as well as any other corresponding documents that it asks you to review. And then create a plan that outlines each of the files that need to be created, briefly what's the content of them, and maybe reference lines within the document, as well as taking the time to fix things within the document that I comment on regarding things like types, of the code-based methods, or fleshing things out, stuff like that. Basically, I want to have a clear idea of what you're going to do to implement this functionality in a way that will ensure that it functions as I've designed it.

docs\plans\feeds.md

Please put your plan inside of this file below. 🔽

---

# Feed Implementation Plan

## Overview
This plan implements a feed system for Civitai that combines Meilisearch for fast search/filtering with ClickHouse for metrics and PostgreSQL for entity data. The system provides caching, batched updates, and efficient document population.

## Key Design Decisions

1. **IMeilisearch Interface**: We define `IMeilisearch` as an interface (not a class). The actual MeiliSearch client from the library will naturally satisfy this interface. Usage: `const client: IMeilisearch = new MeiliSearch({host, apiKey})`

2. **Type Inference**: The `createFeed()` factory uses TypeScript's type inference to extract all generic types from the config object, so you only write `createFeed({ entityType: 'Image', ... })` instead of `createFeed<'Image', TInput, TSchema, ...>(...)`.

3. **Cache Return Types**: Cache config accepts `Promise<T[]>` (easy SQL queries) but returns `Promise<Record<number, T>>` for efficient id->value lookups when populating documents. This matches the MetricService pattern.

4. **Feed Instances**: Feeds are exported as instances (not classes) from the barrel, making initialization in IndexUpdateQueue cleaner with a simple loop.

5. **Meilisearch Optimization**: Feed initialization compares current settings with desired settings before updating to avoid hammering Meilisearch.

6. **No Flush Method**: Caches won't implement `flush()` to avoid Redis key scanning operations.

## Architecture Summary

```
┌─────────────┐
│   Feeds     │ ← Query interface for UI/API
└──────┬──────┘
       │
       ├─→ Meilisearch (search/filter/sort)
       ├─→ CacheService (userData, modelData, etc.)
       ├─→ MetricService (ClickHouse metrics)
       └─→ PostgreSQL (entity details)
```

## File Structure

### Phase 1: Core Infrastructure

#### 1. `src/common/types/package-stubs.ts` (update)
Add interface stubs for clients used by feeds:
- `IDataPacker` interface (msgpackr wrapper)
- Extend `IRedisClient` if needed for packed operations

**References**: feeds.md:58-62

---

#### 2. `src/common/utils/redis-packer.ts` (new)
**Purpose**: Wrapper to add msgpackr binary packing to any IRedisClient

**Content**:
```ts
import { IRedisClient, IDataPacker } from '../types/package-stubs'

export function withRedisPacking(
  redis: IRedisClient,
  packer: IDataPacker
): IRedisClient {
  // Return a proxy that intercepts get/set/mGet operations
  // and wraps values with packer.pack/unpack
}
```

**References**: feeds.md:64-74, cache-helper.md:35-39 (redis.packed usage)
@justin: Be sure to look at how the redis.packed implementation works so we can copy it:
```ts
client.packed = {
  async get<T>(key: K): Promise<T | null> {
    const result = await bufferClient.get<Buffer>(key);
    return result ? unpack(result) : null;
  },

  // Wrapped to avoid CROSSSLOT errors - fetches keys individually with Promise.all
  async mGet<T>(keys: K[]): Promise<(T | null)[]> {
    const results = await Promise.all(keys.map((key) => bufferClient.get<Buffer>(key)));
    return results.map((result) => (result ? unpack(result) : null));
  },

  async set<T>(key: K, value: T, options?: SetOptions): Promise<void> {
    await client.set(key, pack(value), options);
  },

  async setNX<T>(key: K, value: T): Promise<void> {
    await client.setNX(key, pack(value));
  },

  async sAdd<T>(key: K, values: T[]): Promise<void> {
    await client.sAdd(key, values.map(pack));
  },

  async sPop<T>(key: K, count: number): Promise<T[]> {
    const packedValues = await bufferClient.sPop<Buffer>(key, count);
    return packedValues.map((value) => unpack(value));
  },

  async sRemove<T>(key: K, value: T): Promise<void> {
    await client.sRem(key, pack(value));
  },

  async sMembers<T>(key: K): Promise<T[]> {
    const packedValues = await bufferClient.sMembers<Buffer>(key);
    return packedValues.map((value) => unpack(value));
  },

  async hGet<T>(key: K, hashKey: string): Promise<T | null> {
    const result = await bufferClient.hGet<Buffer>(key, hashKey);
    return result ? unpack(result) : null;
  },

  async hGetAll<T>(key: K): Promise<{ [x: string]: T }> {
    const results = await bufferClient.hGetAll<Buffer>(key);
    return Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v ? unpack(v) : null]));
  },

  async hSet<T>(key: K, hashKey: string, value: T): Promise<void> {
    await client.hSet(key, hashKey, pack(value));
  },

  async hmSet<T>(key: K, records: Record<string, T>): Promise<void> {
    const packedRecords: Record<string, Buffer> = {};
    for (const [hashKey, value] of Object.entries(records)) {
      packedRecords[hashKey] = pack(value);
    }
    await client.hSet(key, packedRecords);
  },

  async hmGet<T>(key: K, hashKeys: string[]): Promise<(T | null)[]> {
    const results = await bufferClient.hmGet<Buffer>(key, hashKeys);
    return results.map((result) => (result ? unpack(result) : null));
  },
};
```

---

#### 3. `src/common/utils/async-utils.ts` (new)
**Purpose**: Batching and concurrency utilities

**Content**:
```ts
export function createAsyncBatcher<T>(
  batchSize: number,
  flushFn: (items: T[]) => Promise<void>
) {
  // Implementation from feeds.md:185-215
}

export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  // Implementation from feeds.md:217-247
}
```

**References**: feeds.md:183-248

---

### Phase 2: Cache System

#### 4. `src/common/caches/base.ts` (new)
**Purpose**: Cache factory following cache-helper.md pattern

**Content**:
```ts
import { IRedisClient, IClickhouseClient, IDbClient } from '../types/package-stubs'

export type CacheContext = {
  pg: { query: <T=any>(query: string, params?: any[]) => Promise<T[]> }
  ch: { query: <T=any>(query: string, params?: any[]) => Promise<T[]> }
  redis: IRedisClient // Upgraded to msgPackr IRedis instance
}

export type CacheConfig<T extends object> = {
  redisKey: string // Prefix for cached items
  idKey: keyof T // Property used as key in result Map/object
  fetch: (ctx: CacheContext, ids: number[]) => Promise<T[]> // Returns array, will be converted to Record internally
  ttl?: number // Default cache TTL in seconds
  debounceTime?: number // Time for writes to propagate to read replicas (default 10s)
  cacheNotFound?: boolean // Whether to cache "not found" results
  dontCacheFn?: (data: T) => boolean // Skip caching for certain data
  staleWhileRevalidate?: boolean // Use background revalidation (default true)
}

export function createCache<T extends object>(config: CacheConfig<T>) {
  // Returns object with: { fetch, bust, refresh }
  // Implementation based on cache-helper.md createCachedObject pattern
  // Note: fetch returns Record<number, T> for efficient id->value lookups

  async function fetch(ids: number[]): Promise<Record<number, T>>
  async function bust(id: number | number[], options?: { debounceTime?: number }): Promise<void>
  async function refresh(id: number | number[]): Promise<void>

  return { fetch, bust, refresh }
}

export type Cache<T extends object> = ReturnType<typeof createCache<T>>
```

**Key Features** (from cache-helper.md):
- Distributed locking to prevent cache stampedes (lines 68-82)
- TTL sliding for hot entries (lines 111-129)
- Stale-while-revalidate pattern (lines 58-82)
- Batch operations for efficiency (lines 34-39, 113-117)
- Debounce on bust to prevent immediate refetch (lines 140-156)

**References**: feeds.md:5-25, cache-helper.md:8-231

---

#### 5. `src/common/caches/userData.cache.ts` (new)
**Purpose**: Example cache for user data

**Content**:
```ts
import { createCache, CacheContext } from './base'

export type UserCacheData = {
  userId: number
  username: string
  image?: string
  // ... other user fields
}

export const userData = createCache<UserCacheData>({
  redisKey: 'user:data',
  idKey: 'userId',
  async fetch({ pg }: CacheContext, ids: number[]) {
    const users = await pg.query<UserCacheData>(
      'SELECT id as "userId", username, image FROM "User" WHERE id = ANY($1)',
      [ids]
    )
    return users
  },
  ttl: 60 * 60 * 24 // 24 hours
})
```

**References**: feeds.md:27-43

---

#### 6. `src/common/caches/modelData.cache.ts` (new)
**Purpose**: Cache for model metadata

**Content**:
```ts
import { createCache, CacheContext } from './base'

export type ModelCacheData = {
  modelId: number
  name: string
  type: string
  nsfw: boolean
  userId: number
  // ... other model fields
}

export const modelData = createCache<ModelCacheData>({
  redisKey: 'model:data',
  idKey: 'modelId',
  async fetch({ pg }: CacheContext, ids: number[]) {
    const models = await pg.query<ModelCacheData>(
      `SELECT id as "modelId", name, type, nsfw, "userId"
       FROM "Model" WHERE id = ANY($1)`,
      [ids]
    )
    return models
  },
  ttl: 60 * 60 * 24
})
```

**Note**: Create similar caches for Image, Post, etc. as needed
@justin: Don't worry about making those other caches yet.

---

#### 7. `src/common/caches/index.ts` (new)
**Purpose**: Barrel export for all caches

**Content**:
```ts
export { userData } from './userData.cache'
export { modelData } from './modelData.cache'
// ... export other caches
```

**References**: feeds.md:46-52

---

#### 8. `src/common/services/cache.ts` (new)
**Purpose**: Service to manage all caches with typed access

**Content**:
```ts
import * as caches from '../caches'
import { CacheContext } from '../caches/base'
import { IRedisClient, IDbClient, IClickhouseClient, IDataPacker } from '../types/package-stubs'
import { withRedisPacking } from '../utils/redis-packer'

export class CacheService {
  private context: CacheContext

  constructor(
    redis: IRedisClient,
    pg: IDbClient,
    ch: IClickhouseClient,
    packer?: IDataPacker
  ) {
    this.context = {
      redis: packer ? withRedisPacking(redis, packer) : redis,
      pg: {
        query: async <T=any>(query: string, params?: any[]) => {
          return pg.query(query, params) as Promise<T[]>
        }
      },
      ch: {
        query: async <T=any>(query: string, params?: any[]) => {
          return ch.query(query, params) as Promise<T[]>
        }
      }
    }
  }

  async fetch<K extends keyof typeof caches>(
    name: K,
    ids: number[]
  ): Promise<Awaited<ReturnType<typeof caches[K]['fetch']>>> {
    const cache = caches[name]
    if (!cache) throw new Error(`Cache named '${name}' could not be found`)

    return cache.fetch(this.context, ids)
  }

  // Also expose bust, refresh, flush for each cache
  async bust<K extends keyof typeof caches>(
    name: K,
    ids: number | number[],
    options?: { debounceTime?: number }
  ): Promise<void> {
    const cache = caches[name]
    if (!cache) throw new Error(`Cache named '${name}' could not be found`)

    return cache.bust(ids, options)
  }
}
```

**References**: feeds.md:54-86

---

### Phase 3: Meilisearch Interface

#### 9. `src/common/types/meilisearch-interface.ts` (new)
**Purpose**: Interface to replace meilisearch dependency

**Content**:
```ts
export type MeilisearchTask = {
  taskUid: number
  status: 'enqueued' | 'processing' | 'succeeded' | 'failed'
  // ... minimal task fields we need
}

export type MeilisearchSettings = {
  filterableAttributes?: string[]
  sortableAttributes?: string[]
  searchableAttributes?: string[]
  displayedAttributes?: string[]
  rankingRules?: string[]
}

export type MeilisearchSearchOptions = {
  filter?: string
  sort?: string[]
  limit?: number
  offset?: number
}

export type MeilisearchSearchResult<T> = {
  hits: T[]
  estimatedTotalHits?: number
  // We only care about hits
}

export interface IMeilisearchIndex {
  update(options: { primaryKey: string }): Promise<void>
  getSettings(): Promise<MeilisearchSettings>
  updateSearchableAttributes(attributes: string[]): Promise<MeilisearchTask>
  updateSortableAttributes(attributes: string[]): Promise<MeilisearchTask>
  updateFilterableAttributes(attributes: string[]): Promise<MeilisearchTask>
  updateRankingRules(rules: string[]): Promise<MeilisearchTask>
  updateDocuments(documents: Array<Record<string, any>>): Promise<MeilisearchTask>
  deleteDocuments(ids: number[]): Promise<MeilisearchTask>
  search<T>(query: string | null, options: MeilisearchSearchOptions): Promise<MeilisearchSearchResult<T>>
}

export interface IMeilisearch {
  getIndex(indexName: string): Promise<IMeilisearchIndex>
  createIndex(indexName: string, options?: { primaryKey: string }): Promise<MeilisearchTask>
  waitForTask(taskUid: number): Promise<void>
}
```

**Note on Usage**: This is an interface, not a constructor. The actual MeiliSearch class from the library will satisfy this interface. You'll use it like:
```ts
import { MeiliSearch } from 'meilisearch'
const client: IMeilisearch = new MeiliSearch({ host, apiKey })
```

**References**: feeds.md:88-161

---

#### 10. `src/common/utils/meilisearch-helpers.ts` (new)
**Purpose**: Helper to create and configure Meilisearch indices

**Content**:
```ts
import { IMeilisearch, IMeilisearchIndex } from '../types/meilisearch-interface'

export async function getOrCreateIndex(
  client: IMeilisearch,
  indexName: string,
  options?: { primaryKey: string }
): Promise<IMeilisearchIndex> {
  try {
    const index = await client.getIndex(indexName)
    if (options) {
      await index.update(options)
    }
    return index
  } catch (e: any) {
    if (e.code === 'index_not_found') {
      const task = await client.createIndex(indexName, options)
      await client.waitForTask(task.taskUid)
      return await client.getIndex(indexName)
    }
    throw e
  }
}

export async function getMeilisearchFeed(config: {
  client: IMeilisearch
  name: string
}): Promise<IMeilisearchIndex> {
  const { client, name } = config
  return getOrCreateIndex(client, name, { primaryKey: 'id' })
}
```

**References**: feeds.md:103-180

---

### Phase 4: Feed System

#### 11. `src/common/feeds/types.ts` (new)
**Purpose**: Core feed type definitions

**Content**:
```ts
import { EntityType, EntityMetricMap } from '../types/metric-types'
import * as caches from '../caches'
import { IMeilisearchIndex, MeilisearchSearchOptions } from '../types/meilisearch-interface'

export type FeedContext<E extends EntityType> = {
  pg: {
    query: <T=any>(query: string, params?: any[]) => Promise<T[]>
  }
  ch: {
    query: <T=any>(query: string, params?: any[]) => Promise<T[]>
  }
  cache: {
    fetch: <K extends keyof typeof caches>(
      name: K,
      ids: number[]
    ) => Promise<Awaited<ReturnType<typeof caches[K]['fetch']>>>
  }
  metric: {
    fetch: (ids: number[]) => Promise<Record<number, EntityMetricMap[E]>>
  }
  index: IMeilisearchIndex
}

export type FeedQueryInput<T extends Record<string, any>> = {
  limit?: number
  cursor?: string // '{sortAt}:{id}' - Flexible for multipart cursors
} & T

export type FeedAdvancedOptions = {
  fetchBatchSize: number // default 1000
  upsertBatchSize: number // default 100k
  createConcurrency: number // default 2
}

export type UpsertType = 'full' | 'metrics'

// Helper type to infer document type from schema
export type SchemaFieldType = {
  type: 'string' | 'number' | 'Date' | 'boolean' | 'array'
  arrayType?: 'string' | 'number' | 'boolean' // Only used when type is 'array'
  sortable?: boolean
  filterable?: boolean
  primary?: boolean
}

export type FeedSchema = Record<string, SchemaFieldType>

export type InferSchemaType<S extends FeedSchema> = {
  [K in keyof S]:
    S[K]['type'] extends 'string' ? string :
    S[K]['type'] extends 'number' ? number :
    S[K]['type'] extends 'Date' ? Date :
    S[K]['type'] extends 'boolean' ? boolean :
    S[K]['type'] extends 'array'
      ? S[K] extends { arrayType: infer AT }
        ? AT extends 'string' ? string[]
          : AT extends 'number' ? number[]
          : AT extends 'boolean' ? boolean[]
          : never
        : never
      : never
}

export type CreateFeedConfig<
  E extends EntityType,
  TInput extends Record<string, any>,
  TSchema extends FeedSchema,
  TDocument = InferSchemaType<TSchema>,
  TPopulated = any
> = {
  entityType: E
  name: string
  connection: {
    host: string
    apiKey: string
  }
  schema: TSchema
  // Create flat documents for Meilisearch from entity IDs
  createDocuments: (
    ctx: FeedContext<E>,
    ids: number[],
    type?: UpsertType
  ) => Promise<TDocument[]>
  // Query documents from Meilisearch
  queryDocuments: (
    ctx: FeedContext<E>,
    input: FeedQueryInput<TInput>
  ) => Promise<TDocument[]>
  // Populate documents with related data for API response
  populateDocuments: (
    ctx: FeedContext<E>,
    documents: TDocument[]
  ) => Promise<TPopulated[]>
  options?: Partial<FeedAdvancedOptions>
}
```

**References**: feeds.md:250-298

---

#### 12. `src/common/feeds/base.ts` (new)
**Purpose**: Feed factory implementation

**Content**:
```ts
import { EntityType } from '../types/metric-types'
import { IMeilisearch } from '../types/meilisearch-interface'
import { IClickhouseClient, IDbClient } from '../types/package-stubs'
import { MetricService } from '../services/metrics'
import { CacheService } from '../services/cache'
import { getMeilisearchFeed } from '../utils/meilisearch-helpers'
import { createAsyncBatcher, runWithConcurrency } from '../utils/async-utils'
import { chunk } from '../utils/basic'
import {
  CreateFeedConfig,
  FeedContext,
  FeedAdvancedOptions,
  FeedQueryInput,
  UpsertType,
  InferSchemaType
} from './types'

// Simplified API with type inference
export function createFeed<
  const TConfig extends CreateFeedConfig<EntityType, any, any, any, any>
>(config: TConfig) {
  // Types are inferred from config:
  // - E from config.entityType
  // - TInput from queryDocuments parameter
  // - TSchema from schema
  // - TDocument from createDocuments return type
  // - TPopulated from populateDocuments return type
  const options: FeedAdvancedOptions = {
    fetchBatchSize: 1000,
    upsertBatchSize: 100000,
    createConcurrency: 2,
    ...(config.options ?? {})
  }

  class Feed {
    private client: IMeilisearch
    private context: FeedContext<E>
    private index: IMeilisearchIndex | undefined
    private indexError: Error | undefined
    private indexReady: Promise<boolean>

    constructor(
      meilisearch: IMeilisearch,
      ch: IClickhouseClient,
      pg: IDbClient,
      metricService: MetricService,
      cacheService: CacheService
    ) {
      this.client = meilisearch

      // Initialize index
      this.indexReady = getMeilisearchFeed({
        client: this.client,
        name: config.name
      })
        .then(async (index) => {
          this.index = index

          // Get current settings to avoid unnecessary updates
          const currentSettings = await index.getSettings()

          // Configure index based on schema
          const sortable: string[] = []
          const filterable: string[] = []
          const searchable: string[] = []

          for (const [field, fieldConfig] of Object.entries(config.schema)) {
            if (fieldConfig.sortable) sortable.push(field)
            if (fieldConfig.filterable) filterable.push(field)
            // By default, string fields are searchable
            // @justin: Actually, we don't want anything to be searchable, we're going to leave these as filter and sort only indexes.
            // if (fieldConfig.type === 'string') searchable.push(field)
          }

          // Only update if changed to avoid hammering Meilisearch
          const sortableChanged = JSON.stringify(sortable.sort()) !== JSON.stringify((currentSettings.sortableAttributes ?? []).sort())
          const filterableChanged = JSON.stringify(filterable.sort()) !== JSON.stringify((currentSettings.filterableAttributes ?? []).sort())
          // const searchableChanged = JSON.stringify(searchable.sort()) !== JSON.stringify((currentSettings.searchableAttributes ?? []).sort())

          if (sortableChanged && sortable.length) await index.updateSortableAttributes(sortable)
          if (filterableChanged && filterable.length) await index.updateFilterableAttributes(filterable)
          // if (searchableChanged && searchable.length) await index.updateSearchableAttributes(searchable)

          return true
        })
        .catch((err) => {
          this.indexError = err as Error
          console.error(err)
          return false
        })

      // Build context
      this.context = {
        pg: {
          query: async <T=any>(query: string, params?: any[]) => {
            return pg.query(query, params) as Promise<T[]>
          }
        },
        ch: {
          query: async <T=any>(query: string, params?: any[]) => {
            return ch.query(query, params) as Promise<T[]>
          }
        },
        cache: {
          fetch: (name, ids) => cacheService.fetch(name, ids)
        },
        metric: {
          fetch: async (ids) => {
            // Extract entity type from config - need to pass this somehow
            return metricService.fetch(entityType, ids)
          }
        },
        get index() {
          if (!this.index) throw new Error('Index not ready')
          return this.index
        }
      } as FeedContext<E>
    }

    private async ready() {
      if (!(await this.indexReady)) throw this.indexError ?? new Error('Index failed to initialize')
      if (!this.index) throw new Error('Index not available')
    }

    async delete(ids: number[]): Promise<void> {
      await this.ready()
      await this.index!.deleteDocuments(ids)
    }

    async upsert(ids: number[], type: UpsertType = 'full'): Promise<void> {
      await this.ready()

      const batcher = createAsyncBatcher(
        options.upsertBatchSize,
        async (docs) => this.index!.updateDocuments(docs as any)
      )

      const batches = chunk(ids, options.fetchBatchSize)

      const tasks = batches.map((batch) => async () => {
        const docs = await config.createDocuments(this.context, batch, type)
        batcher.enqueue(docs as any)
      })

      await runWithConcurrency(tasks, options.createConcurrency)
      await batcher.flush()
    }

    async query(input: FeedQueryInput<TInput>): Promise<TDocument[]> {
      await this.ready()
      const docs = await config.queryDocuments(this.context, input)
      return docs
    }

    async populate(docs: TDocument[]): Promise<TPopulated[]> {
      await this.ready()
      const populatedDocs = await config.populateDocuments(this.context, docs)
      return populatedDocs
    }

    async populatedQuery(input: FeedQueryInput<TInput>): Promise<TPopulated[]> {
      const docs = await this.query(input)
      return await this.populate(docs)
    }
  }

  return Feed
}
```

**References**: feeds.md:300-384

---

#### 13. `src/common/feeds/image.feed.ts` (new)
**Purpose**: Example image feed implementation

**Content**:
```ts
import { createFeed } from './base'
import { FeedContext, FeedQueryInput } from './types'

const schema = {
  id: { type: 'number', primary: true, filterable: true },
  userId: { type: 'number', filterable: true },
  postId: { type: 'number', filterable: true },
  modelVersionId: { type: 'number', filterable: true },
  nsfw: { type: 'boolean', filterable: true },
  width: { type: 'number', sortable: true },
  height: { type: 'number', sortable: true },
  createdAt: { type: 'Date', sortable: true },
  // Metrics
  heartCount: { type: 'number', sortable: true },
  likeCount: { type: 'number', sortable: true },
  commentCount: { type: 'number', sortable: true }
} as const

type ImageDocument = {
  id: number
  userId: number
  postId: number | null
  modelVersionId: number | null
  nsfw: boolean
  width: number
  height: number
  createdAt: Date
  heartCount: number
  likeCount: number
  commentCount: number
}

type ImageQueryInput = {
  nsfw?: boolean
  userId?: number
  modelVersionId?: number
}

type PopulatedImage = ImageDocument & {
  url: string
  username: string
  // ... other populated fields
}

export const ImageFeed = createFeed({
  entityType: 'Image' as const,
  name: 'images',
  connection: {
    host: process.env.MEILISEARCH_IMAGE_INDEX_URL!,
    apiKey: process.env.MEILISEARCH_API_KEY!
  },
  schema,

  async createDocuments(ctx, ids, type = 'full') {
    // Fetch base data from PostgreSQL
    const images = await ctx.pg.query<ImageDocument>(
      `SELECT id, "userId", "postId", "modelVersionId",
              nsfw, width, height, "createdAt"
       FROM "Image" WHERE id = ANY($1)`,
      [ids]
    )

    // Fetch metrics
    const imageIds = images.map(img => img.id)
    const metrics = await ctx.metric.fetch(imageIds)

    // Combine
    return images.map(img => ({
      ...img,
      heartCount: metrics[img.id]?.Heart ?? 0,
      likeCount: metrics[img.id]?.Like ?? 0,
      commentCount: metrics[img.id]?.commentCount ?? 0
    }))
  },

  async queryDocuments(ctx, input) {
    const { limit = 20, cursor, nsfw, userId, modelVersionId } = input

    // Build filter
    const filters: string[] = []
    if (nsfw !== undefined) filters.push(`nsfw = ${nsfw}`)
    if (userId) filters.push(`userId = ${userId}`)
    if (modelVersionId) filters.push(`modelVersionId = ${modelVersionId}`)

    // Parse cursor
    let cursorFilter = ''
    if (cursor) {
      const [createdAt, id] = cursor.split(':')
      cursorFilter = `createdAt < ${createdAt} OR (createdAt = ${createdAt} AND id < ${id})`
      if (filters.length) cursorFilter = ` AND (${cursorFilter})`
    }

    const result = await ctx.index.search<ImageDocument>(null, {
      filter: filters.join(' AND ') + cursorFilter,
      sort: ['createdAt:desc', 'id:desc'],
      limit,
      offset: 0
    })

    return result.hits
  },

  async populateDocuments(ctx, documents) {
    // Fetch user data
    const userIds = [...new Set(documents.map(d => d.userId))]
    const users = await ctx.cache.fetch('userData', userIds)

    // Combine
    return documents.map(doc => ({
      ...doc,
      url: `https://image.civitai.com/${doc.id}`,
      username: users[doc.userId]?.username ?? 'unknown'
    }))
  }
})
```

**References**: feeds.md:387-392

---

#### 14. `src/common/feeds/index.ts` (new)
**Purpose**: Barrel export for all feeds

**Content**:
```ts
export { ImageFeed } from './image.feed'
// Add other feeds as needed (modelFeed, postFeed, etc.)
```

**References**: feeds.md:394-399

---

### Phase 5: Integration with Index Update Queue

#### 15. `src/services/index-update-queue.ts` (update)
**Purpose**: Integrate feeds with existing index update queue

**Changes**:
- Import feed instances
- Initialize feeds in constructor
- Update `updateIndex()` to call feed.upsert() based on update type
- Support both 'metrics' and 'full' update types

**Key Updates**:
```ts
import * as feeds from '../common/feeds'

export class IndexUpdateQueue {
  private feeds: Record<string, any> = {}

  constructor(...) {
    // Initialize feed instances
    this.feeds.set('image', new feeds.ImageFeed(
      meilisearchClient,
      clickhouseClient,
      pgClient,
      metricService,
      cacheService
    ))
    // ... other feeds

    // Initialize all feeds using barrel export
    for (const [name, Feed] of Object.entries(feeds)) {
      this.feeds[name] = new Feed(
        meilisearchClient,
        clickhouseClient,
        pgClient,
        metricService,
        cacheService
      )
    }
  }

  private async updateIndex(entityType: string, entityIds: number[], type: UpsertType = 'full') {
    const feed = this.feeds[entityType]
    if (!feed) {
      logger.warn(`No feed configured for entity type: ${entityType}`)
      return
    }

    await feed.upsert(entityIds, type)
  }
}
```

**References**: feeds.md:401-402, index-update-queue.ts:184 (Justin's comment)

---

## Type Fixes & Clarifications for feeds.md

### Issue 1: CacheConfig type parameter (feeds.md:21-24)
**Current**:
```ts
type CacheConfig = {
  fetch: (ctx: CacheContext, ids: number[]) => Promise<T extends Record<string, any>[]>
}
```

**Fixed** (in plan above, file #4):
```ts
type CacheConfig<T extends object> = {
  fetch: (ctx: CacheContext, ids: number[]) => Promise<T[]> // Array from user's fetch fn
}

// But the cache returns Record for efficient lookups:
async function fetch(ids: number[]): Promise<Record<number, T>>
```
@meta: The cache config accepts an array from the user's fetch function (easier to write SQL queries that return arrays), but internally converts it to a Record<number, T> keyed by idKey for efficient id->value lookups when populating documents. This matches the MetricService pattern.

---

### Issue 2: CacheService result type (feeds.md:77-84)
**Current issue**: Need proper type inference for cache fetch results

**Fixed** (in plan above, file #8):
```ts
async fetch<K extends keyof typeof caches>(
  name: K,
  ids: number[]
): Promise<Awaited<ReturnType<typeof caches[K]['fetch']>>> {
  // Type is automatically inferred from cache name
}
```
@justin: Perfect. Thank you!

---

### Issue 3: IMeilisearch interface (feeds.md:92)
**Completed** in plan above (file #9) - full interface specification based on usage patterns

---

### Issue 4: getMeilisearchFeed client parameter (feeds.md:320)
**Current**:
```ts
async function getMeilisearchFeed(client: IMeilisearch, config: {...})
```

**Fixed** (in plan above, file #10):
```ts
async function getMeilisearchFeed(config: {
  client: IMeilisearch
  name: string
})
```

---

### Issue 5: Feed query input type (feeds.md:363-364)
**Current issue**: How to get input type from config

**Fixed** (in plan above, file #12):
```ts
// Use generic parameter TInput
async query(input: FeedQueryInput<TInput>): Promise<TDocument[]>
```

---

### Issue 6: InferFromSchema type (feeds.md:269, 370)
**Completed** in plan above (file #11) - full type inference from schema definition

---

## Implementation Order

### Phase 1: Foundation (Days 1-2)
1. `src/common/utils/async-utils.ts` - No dependencies
2. `src/common/utils/redis-packer.ts` - Basic wrapper
3. `src/common/types/meilisearch-interface.ts` - Type definitions only
4. `src/common/utils/meilisearch-helpers.ts` - Uses interface

### Phase 2: Cache System (Days 2-3)
5. `src/common/caches/base.ts` - Core cache factory
6. `src/common/caches/userData.cache.ts` - Example cache
7. `src/common/caches/modelData.cache.ts` - Example cache
8. `src/common/caches/index.ts` - Barrel export
9. `src/common/services/cache.ts` - Cache service

### Phase 3: Feed System (Days 3-5)
10. `src/common/feeds/types.ts` - Type definitions
11. `src/common/feeds/base.ts` - Feed factory
12. `src/common/feeds/image.feed.ts` - Example feed
13. `src/common/feeds/index.ts` - Barrel export

### Phase 4: Integration (Day 5)
14. Update `src/services/index-update-queue.ts` - Integrate feeds
15. Testing and refinement

---

## Testing Strategy

1. **Unit Tests**: Test each cache independently
2. **Integration Tests**: Test feed creation and querying
3. **Load Tests**: Verify batching and concurrency limits
4. **Cache Stampede Tests**: Verify distributed locking works

---

## Additional Considerations

### Metrics Pipeline (feeds.md:184 comment)
**Separate Plan**: `docs/plans/meilisearch-index-update-pipelines.md`
- Two update types: 'metrics' (lightweight) vs 'full' (complete document)
- Queue tracks update type needed
- Feed system already supports this via `UpsertType`
@justin: Right. We can disregard the plan in `meilisearch-index-update-pipelines.md`

### EntityType in Feed Context
The Feed class needs to know its entity type for metric fetching. Options:
1. Pass entity type as generic parameter to createFeed
2. Store entity type in config
3. Add entity type to FeedContext

**Chosen approach** (in plan): Pass as generic parameter `E extends EntityType`

---

## Questions for Review


1. **Redis Packer**: Should we use msgpackr specifically, or accept any IDataPacker? (Currently designed for flexibility)
@justin: Theoretically we can support anything, but for the implementation of IDataPacker within the project that is passed in to `src/common` (which is a submodule that is shared), we should use msgpackr

2. **Cache TTL defaults**: Are the current defaults reasonable?
   - CACHE_TTL: 24 hours
   - MISS_CACHE_TTL: 5 minutes
   - CACHE_SLIDE_CHANCE: 10%
@justin: Yes

3. **Feed entity type**: In createFeed, how should we associate the entity type? Currently using generic parameter `E extends EntityType`.
@justin: That's reasonable.

4. **Meilisearch client creation**: Who creates the IMeilisearch instance? Should feeds create their own clients or share a pool?
@justin: The feeds will be creating their own instance since they might have different host/apiKeys.

5. **Additional caches needed**: Beyond userData and modelData, which other caches should we create initially?
@justin: Don't worry about other caches for now. Just make sure that userData and modelData are a good example.

6. **Schema validation**: Should we add runtime schema validation or rely on TypeScript?
@justin: Let's just rely on typescript
