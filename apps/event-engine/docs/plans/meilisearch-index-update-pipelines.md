# Meilisearch Index Update Pipelines

## Problem Statement

Currently, the `IndexUpdateQueue` in `src/services/index-update-queue.ts` only supports updating metrics in Meilisearch documents. However, many events trigger changes to other document fields beyond metrics (e.g., status changes, deletions, metadata updates). We need:

1. **Metrics-only updates**: Lightweight updates when only metrics change (current functionality)
2. **Full document updates**: Complete document refresh when non-metric fields change
3. **Entity-specific data fetching**: Different entities require different data queries
4. **Batch efficiency**: Fetch all required data in batches to minimize database queries

## Current Architecture

### IndexUpdateQueue (`src/services/index-update-queue.ts`)

```typescript
interface IndexUpdate {
  entityType: string
  entityId: number
  type: 'update' | 'delete' | 'metricUpdate'  // Currently only 'metricUpdate' is used
}
```

**Current Flow:**
1. Handler calls `actions.indexUpdate(entityType, entityId, type)`
2. Queue batches updates by entity type
3. On flush, calls `fetchMetrics()` → `MetricService.fetch()`
4. Updates Meilisearch documents with metrics only

## Proposed Architecture

### 1. Enhanced IndexUpdate Type

```typescript
interface IndexUpdate {
  entityType: string
  entityId: number
  type: 'delete' | 'metricUpdate' | 'fullUpdate'
}
```

**Update Types:**
- `delete`: Remove document from index
- `metricUpdate`: Update only metric fields (lightweight)
- `fullUpdate`: Fetch and update entire document (heavyweight)

### 2. Pipeline Structure

```
src/
├── services/
│   ├── index-update-queue.ts          # Queue manager (modified)
│   └── index-pipelines/               # New directory
│       ├── index.ts                   # Pipeline registry & orchestrator
│       ├── types.ts                   # Shared types for pipelines
│       ├── metrics-pipeline.ts        # Metrics-only updates
│       ├── full-update-pipeline.ts    # Full document updates
│       └── delete-pipeline.ts         # Document deletions
└── documents/                         # New directory
    ├── index.ts                       # Document fetcher registry (barrel)
    ├── types.ts                       # Document type definitions
    ├── model.ts                       # Model document fetcher
    ├── model-version.ts               # ModelVersion document fetcher
    ├── post.ts                        # Post document fetcher
    ├── image.ts                       # Image document fetcher
    └── [entity].ts                    # Other entity fetchers
```

### 3. Pipeline Implementations

#### Base Pipeline Interface

```typescript
// src/services/index-pipelines/types.ts

export interface Pipeline {
  name: string
  canHandle(update: IndexUpdate): boolean
  process(updates: Map<string, Set<number>>, clients: Map<string, MeiliSearch>): Promise<void>
}

export interface DocumentFetcher<T = any> {
  entityType: string
  fetch(entityIds: number[]): Promise<Record<number, T>>
}
```

#### Metrics Pipeline

```typescript
// src/services/index-pipelines/metrics-pipeline.ts

export class MetricsPipeline implements Pipeline {
  name = 'metrics'

  constructor(private metricService: MetricService) {}

  canHandle(update: IndexUpdate): boolean {
    return update.type === 'metricUpdate'
  }

  async process(updates: Map<string, Set<number>>, clients: Map<string, MeiliSearch>): Promise<void> {
    for (const [entityType, entityIds] of updates.entries()) {
      // Use existing MetricService.fetch() - already batched
      const metrics = await this.metricService.fetch(entityType, Array.from(entityIds))

      // Format for Meilisearch partial update
      const documents = Object.entries(metrics).map(([id, data]) => ({
        id: parseInt(id),
        ...data
      }))

      const index = clients.get(entityType)?.index(`${entityType.toLowerCase()}s`)
      await index?.updateDocuments(documents)
    }
  }
}
```

#### Full Update Pipeline

```typescript
// src/services/index-pipelines/full-update-pipeline.ts

import { documentFetchers } from '@/documents'

export class FullUpdatePipeline implements Pipeline {
  name = 'fullUpdate'

  canHandle(update: IndexUpdate): boolean {
    return update.type === 'fullUpdate'
  }

  async process(updates: Map<string, Set<number>>, clients: Map<string, MeiliSearch>): Promise<void> {
    for (const [entityType, entityIds] of updates.entries()) {
      const fetcher = documentFetchers[entityType]
      if (!fetcher) {
        logger.warn(`No document fetcher for entity type: ${entityType}`)
        continue
      }

      // Fetch complete documents (batched internally)
      const documents = await fetcher.fetch(Array.from(entityIds))

      // Update Meilisearch
      const index = clients.get(entityType)?.index(`${entityType.toLowerCase()}s`)
      await index?.updateDocuments(Object.values(documents))
    }
  }
}
```

#### Delete Pipeline

```typescript
// src/services/index-pipelines/delete-pipeline.ts

export class DeletePipeline implements Pipeline {
  name = 'delete'

  canHandle(update: IndexUpdate): boolean {
    return update.type === 'delete'
  }

  async process(updates: Map<string, Set<number>>, clients: Map<string, MeiliSearch>): Promise<void> {
    for (const [entityType, entityIds] of updates.entries()) {
      const index = clients.get(entityType)?.index(`${entityType.toLowerCase()}s`)
      await index?.deleteDocuments(Array.from(entityIds))
    }
  }
}
```

### 4. Document Fetchers

Each entity type needs its own document fetcher that:
- Accepts an array of entity IDs
- Fetches all required data (from Postgres, ClickHouse, Redis, etc.)
- Returns documents formatted for Meilisearch
- Handles batching internally for large ID sets

#### Example: Model Document Fetcher

```typescript
// src/documents/model.ts

import { DocumentFetcher } from '@/services/index-pipelines/types'
import { db } from '@/db'
import { metricService } from '@/services'

export interface ModelDocument {
  id: number
  name: string
  type: string
  status: string
  userId: number
  nsfw: boolean
  // ... other searchable fields
  // Metrics
  downloadCount: number
  favoriteCount: number
  commentCount: number
  // ... other metrics
}

export const modelDocumentFetcher: DocumentFetcher<ModelDocument> = {
  entityType: 'Model',

  async fetch(entityIds: number[]): Promise<Record<number, ModelDocument>> {
    if (entityIds.length === 0) return {}

    // Fetch base model data from Postgres
    const models = await db.model.findMany({
      where: { id: { in: entityIds } },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        userId: true,
        nsfw: true,
        // ... other fields
      }
    })

    // Fetch metrics from MetricService (uses ClickHouse + Redis cache)
    const metrics = await metricService.fetch('Model', entityIds)

    // Combine data
    const documents: Record<number, ModelDocument> = {}
    for (const model of models) {
      documents[model.id] = {
        ...model,
        ...(metrics[model.id] || {})
      }
    }

    return documents
  }
}
```

#### Example: Post Document Fetcher

```typescript
// src/documents/post.ts

export interface PostDocument {
  id: number
  title: string
  userId: number
  publishedAt: Date | null
  // ... other fields
  likeCount: number
  commentCount: number
  // ... other metrics
}

export const postDocumentFetcher: DocumentFetcher<PostDocument> = {
  entityType: 'Post',

  async fetch(entityIds: number[]): Promise<Record<number, PostDocument>> {
    // Similar pattern to model fetcher
    // Fetch from appropriate data sources
    // Combine and return
  }
}
```

#### Document Fetcher Registry

```typescript
// src/documents/index.ts

import { modelDocumentFetcher } from './model'
import { postDocumentFetcher } from './post'
import { imageDocumentFetcher } from './image'
// ... import other fetchers

export const documentFetchers = {
  Model: modelDocumentFetcher,
  Post: postDocumentFetcher,
  Image: imageDocumentFetcher,
  // ... register other fetchers
} as const

export type EntityType = keyof typeof documentFetchers
```

### 5. Modified IndexUpdateQueue

```typescript
// src/services/index-update-queue.ts

import { Pipeline } from './index-pipelines/types'
import { MetricsPipeline } from './index-pipelines/metrics-pipeline'
import { FullUpdatePipeline } from './index-pipelines/full-update-pipeline'
import { DeletePipeline } from './index-pipelines/delete-pipeline'

export class IndexUpdateQueue {
  private updates: Map<string, Map<'delete' | 'metricUpdate' | 'fullUpdate', Set<number>>> = new Map()
  private pipelines: Pipeline[]

  constructor(
    private metricService: MetricService,
    private updateIntervalMs: number = config.app.indexUpdateIntervalMs,
    private maxBatchSize: number = 1000
  ) {
    this.initializeClients()
    this.pipelines = [
      new DeletePipeline(),
      new MetricsPipeline(metricService),
      new FullUpdatePipeline()
    ]
  }

  add(update: IndexUpdate): void {
    if (!config.app.indexUpdateEnabled) return

    const entityKey = update.entityType.toLowerCase()

    if (!this.updates.has(entityKey)) {
      this.updates.set(entityKey, new Map())
    }

    const entityUpdates = this.updates.get(entityKey)!

    if (!entityUpdates.has(update.type)) {
      entityUpdates.set(update.type, new Set())
    }

    entityUpdates.get(update.type)!.add(update.entityId)

    // Update metrics and check for early flush
    // ...
  }

  private async processBatches(): Promise<void> {
    // Group updates by type
    const updatesByType: Map<'delete' | 'metricUpdate' | 'fullUpdate', Map<string, Set<number>>> = new Map()

    for (const [entityType, typeMap] of this.updates.entries()) {
      for (const [updateType, entityIds] of typeMap.entries()) {
        if (!updatesByType.has(updateType)) {
          updatesByType.set(updateType, new Map())
        }
        updatesByType.get(updateType)!.set(entityType, entityIds)
      }
    }

    // Process each type with its pipeline
    for (const [updateType, updates] of updatesByType.entries()) {
      const pipeline = this.pipelines.find(p => p.canHandle({ type: updateType } as IndexUpdate))

      if (pipeline) {
        try {
          await pipeline.process(updates, this.clients)
          logger.debug(`Pipeline '${pipeline.name}' processed ${updates.size} entity types`)
        } catch (err) {
          logger.error({ err, pipeline: pipeline.name }, 'Pipeline processing failed')
          // Re-queue failed updates
          // ...
        }
      }
    }
  }
}
```

### 6. Handler Usage Examples

#### Metrics-only Update

```typescript
// src/handlers/image-reactions.ts
export const imageReactionHandler = createReactionHandler({
  entityTypes: ['Image', 'Post'],
  processor: async ({ current, actions }) => {
    // Emit metrics
    actions.metricEvent(...)

    // Queue metrics-only update
    actions.indexUpdate(current.imageId, 'Image', 'metricUpdate')
  }
})
```

#### Full Document Update

```typescript
// src/handlers/outbox/model.ts
export const modelHandler = createOutboxHandler({
  entityTypes: ['Model'],
  events: [OutboxEvent.UPDATED, OutboxEvent.PUBLISHED],
  processor: async ({ event, entityId, actions }) => {
    // Non-metric fields changed, need full refresh
    actions.indexUpdate(entityId, 'Model', 'fullUpdate')
  }
})
```

#### Delete Update

```typescript
// src/handlers/outbox/model.ts
export const modelHandler = createOutboxHandler({
  entityTypes: ['Model'],
  events: [OutboxEvent.DELETED],
  processor: async ({ event, entityId, actions }) => {
    actions.indexUpdate(entityId, 'Model', 'delete')
  }
})
```

## Implementation Plan

### Phase 1: Foundation
1. ✅ Create directory structure (`src/services/index-pipelines/`, `src/documents/`)
2. ✅ Define types and interfaces (`types.ts` in both directories)
3. ✅ Create pipeline registry and orchestrator (`src/services/index-pipelines/index.ts`)

### Phase 2: Pipeline Implementation
4. ✅ Implement `DeletePipeline` (simplest)
5. ✅ Extract current logic into `MetricsPipeline`
6. ✅ Implement `FullUpdatePipeline` shell
7. ✅ Refactor `IndexUpdateQueue` to use pipelines

### Phase 3: Document Fetchers
8. ✅ Implement `Model` document fetcher
9. ✅ Implement `Post` document fetcher
10. ✅ Implement `Image` document fetcher
11. ✅ Create fetcher registry barrel file

### Phase 4: Integration
12. ✅ Update handlers to use appropriate update types
13. ✅ Add Prometheus metrics for pipeline performance
14. ✅ Test with real data

### Phase 5: Optimization
15. ✅ Add caching strategies for full document fetches
16. ✅ Optimize batch sizes per pipeline
17. ✅ Add pipeline-specific retry logic

## Benefits

1. **Separation of Concerns**: Each pipeline handles one type of update
2. **Extensibility**: Easy to add new pipelines (e.g., `partialUpdate` for specific field sets)
3. **Performance**: Metrics pipeline remains lightweight, full updates only when needed
4. **Type Safety**: TypeScript types for each document structure
5. **Maintainability**: Clear structure for adding new entity types
6. **Batching**: All pipelines leverage batch operations for efficiency

## Migration Strategy

1. Implement pipelines alongside existing code
2. Migrate `metricUpdate` logic first (no breaking changes)
3. Add `fullUpdate` and `delete` support incrementally
4. Update handlers one entity type at a time
5. Monitor metrics to ensure no performance regression

## Open Questions

1. **Priority ordering**: Should `delete` always process before `fullUpdate`?
   - *Recommendation*: Yes, process deletes first to avoid wasted work

2. **Conflict resolution**: What if same entity has both `metricUpdate` and `fullUpdate` queued?
   - *Recommendation*: `fullUpdate` supersedes `metricUpdate` (include metrics in full fetch)

3. **Partial failures**: How to handle when some documents fail to fetch?
   - *Recommendation*: Re-queue failed IDs, log errors, update metrics

4. **Rate limiting**: Should we throttle full updates to avoid overwhelming Postgres?
   - *Recommendation*: Add configurable max concurrent full updates

@meta:* Review this plan and let me know if you have any suggestions or if I should proceed with implementation.
