# Migration Plan: From Debezium-Centric to Topic-Based Event Handling

## Overview

Currently, the event handling system is built around Debezium CDC patterns with `table:operation` mappings. We need to migrate to a more flexible topic-based system that:
- Allows handlers to subscribe directly to Kafka topics
- Still supports legacy `table` + `operation` patterns (which map to topics under the hood)
- Enables processing of non-database events (e.g., application events, manual triggers)

## Current Architecture

### Event Flow
1. **EventProcessor** receives events from Kafka topics via `handleKafkaEvent(event, topic)`
2. Extracts `tableName` from topic using `getTableFromTopic(topic)`
3. Maps Debezium operation using `mapOperation(event.op)`
4. Builds lookup key as `${tableName}:${operation}`
5. Finds handlers via `HandlerMapper` that match this key

### Handler Definition
Handlers currently define:
```typescript
{
  tables: string[]        // e.g., ['ImageReaction', 'UserEngagement']
  operations: Operation[] // e.g., ['create', 'delete', 'update']
}
```

These are transformed into lookup keys: `${table}:${operation}`

### Handler Types
- **Standard EventHandler**: `table` + `operation` → Debezium CDC events
- **OutboxHandler**: `entityType` + `event` → Outbox pattern events
- **ManualHandler**: `event` → Manual events from ClickHouse

## Target Architecture

### Unified Topic-Based Subscription

All handlers should ultimately subscribe to **topics**, with `tables` and `operations` being a convenience that generates topic patterns under the hood.

```typescript
// New flexible approach
{
  topics: string[]  // Direct topic subscription

  // OR legacy approach (generates topics internally)
  tables: string[]
  operations: Operation[]
}
```

### Topic Naming Convention

**Debezium topics** (legacy):
- Pattern: `postgres.TableName` → handler subscribes to `postgres.TableName:create`, `postgres.TableName:delete`, etc.
- This maintains backwards compatibility

**Application topics** (new):
- Pattern: `app.event-name` or custom topic names
- No operation suffix needed
- Examples: `app.user-login`, `metrics.recalculate`, `notifications.sent`

## Migration Steps

### Phase 1: Update Type Definitions

**File**: `src/types/handlers.ts`

1. Add `topics` field to handler configs and use discriminated union:
```typescript
// Discriminated union: must use EITHER topics OR tables+operations
type EventHandlerConfig<T = any> = {
  processor: (ctx: HandlerContext<T>) => Promise<void>
  debug?: DebugConfigFactory<T>
  metrics?: Record<string, string[]>
} & (
  | { topics: string[]; tables?: never; operations?: never }          // Topic-based
  | { tables: string[]; operations: Operation[]; topics?: never }     // Legacy CDC
)

export interface EventHandler<T = any> {
  topics?: string[]        // NEW
  // ... rest stays same
}
```

@meta: `canHandle` is currently used during handler registration in `buildHandlerMap()`. However, you're right - it's redundant since we pre-compute all mappings via `HandlerMapper`. We should **remove `canHandle`** entirely and rely solely on the mapper. The handler just needs to declare what it handles via `topics`/`tables`/`operations`, not check at runtime.
@justin:* Perfect. Let's do that...

### Phase 2: Update Handler Factories

**File**: `src/handlers/base.ts`

Update `createEventHandler` to support both patterns:

```typescript
export function createEventHandler<T = any>(config: EventHandlerConfig<T>): EventHandler<T> {
  // Determine lookup keys
  let lookupKeys: string[]

  if ('topics' in config) {
    // Direct topic subscription
    lookupKeys = config.topics
  } else {
    // Legacy: generate table:operation keys
    lookupKeys = []
    config.tables.forEach(table => {
      const normalized = table.replace('postgres.', '')
      config.operations.forEach(op => {
        lookupKeys.push(`${normalized}:${op}`)
      })
    })
  }

  return {
    topics: lookupKeys,
    process: config.processor,
    debug: config.debug,
    tables: 'tables' in config ? config.tables : undefined,
    operations: 'operations' in config ? config.operations : undefined,
    metrics: config.metrics
  }
}
```

@meta: Removed `canHandle` - it's now handled entirely by the pre-computed `HandlerMapper`

### Phase 3: Update Handler Mapper

**File**: `src/utils/handler-mapper.ts`

Update `createEventHandlerMapper` to use topics:

```typescript
export function createEventHandlerMapper<T extends { handler: MappableHandler }>() {
  return new HandlerMapper<T>(
    ({ handler }) => {
      const keys: string[] = []

      // NEW: Direct topic support
      if (handler.topics) {
        keys.push(...handler.topics)
      }

      // Legacy: table:operation mapping
      if (handler.tables && handler.operations) {
        handler.tables.forEach(table => {
          const normalizedTable = table.replace('postgres.', '')
          handler.operations!.forEach(operation => {
            keys.push(`${normalizedTable}:${operation}`)
          })
        })
      }

      return keys.length > 0 ? keys : null
    }
  )
}
```

Update `MappableHandler` interface:
```typescript
export interface MappableHandler {
  topics?: string[]    // NEW
  tables?: string[]
  operations?: string[]
}
```

### Phase 4: Update Event Processor

**File**: `src/services/event-processor.ts`

@meta: Great insight! We should:
1. Accept a generic `payload: any` instead of `DebeziumPayload`
2. Detect if it's Debezium format (has `op`, `before`, `after`)
3. For legacy handlers (using `tables`/`operations`), require Debezium format
4. For topic-based handlers, pass raw payload directly
5. Stop converting ClickHouse → Debezium in `index.ts` and migrate those handlers to topic-based

**Updated approach:**

```typescript
handleKafkaEvent(payload: any, topic: string): void {
  if (!this.isRunning) return

  // Detect if this is Debezium format
  const isDebezium = payload.op && ('before' in payload || 'after' in payload)

  let lookupKey: string
  let operation: Operation | undefined

  if (isDebezium) {
    // Legacy Debezium path: table:operation
    operation = mapOperation(payload.op)
    const tableName = getTableFromTopic(topic)
    lookupKey = `${tableName}:${operation}`

    eventProcessorMetrics.messagesReceived.inc({ topic: tableName, operation })
  } else {
    // Topic-based path: direct topic match
    lookupKey = topic
    eventProcessorMetrics.messagesReceived.inc({ topic, operation: 'n/a' })
  }

  // O(1) lookup
  const handlers = this.handlerMapper.get(lookupKey)

  if (handlers.length === 0) {
    eventProcessorMetrics.messagesIgnored.inc({ topic, operation: operation || 'n/a' })
    return
  }

  logger.debug(`Processing ${handlers.length} handler(s) for ${lookupKey}`)

  handlers.forEach(({ name, handler }) => {
    eventProcessorMetrics.handlersMatched.inc({ topic, operation: operation || 'n/a', handler: name })
    this.enqueueForProcessing({ event: payload, handler, handlerName: name })
  })
}
```

**Update `createHandlerContext`:**
```typescript
private createHandlerContext(payload: any): HandlerContext {
  const isDebezium = payload.op && ('before' in payload || 'after' in payload)

  if (isDebezium) {
    const operation = mapOperation(payload.op)
    return {
      pg: { query: this.pgQueryMemoized, queryOne: this.pgQueryOneMemoized },
      ch: { ... },
      old: payload.before,
      current: payload.after,
      record: ['create', 'update'].includes(operation) ? payload.after : payload.before,
      operation,
      actions: this.createActions()
    }
  } else {
    // Topic-based: no old/current/operation
    return {
      pg: { query: this.pgQueryMemoized, queryOne: this.pgQueryOneMemoized },
      ch: { ... },
      old: null,
      current: null,
      record: payload,  // Raw payload
      operation: undefined,
      actions: this.createActions()
    }
  }
  // Simplified DRY version:
  const operation = isDebezium ? mapOperation(payload.op) : 'create'

  return {
    pg: { query: this.pgQueryMemoized, queryOne: this.pgQueryOneMemoized },
    ch: { ... },
    old: isDebezium ? payload.before : undefined,
    current: isDebezium ? payload.after : payload,
    record: isDebezium ? (['create', 'update'].includes(operation) ? payload.after : payload.before) : payload,
    operation,  // Always has a value - Debezium op or 'create' for non-Debezium
    actions: this.createActions()
  }
}
```

### Phase 5: Migration Examples

**Existing handler** (backwards compatible):
```typescript
// This continues to work unchanged
export const imageReactionHandler = createReactionHandler<ImageReactionRecord>({
  table: 'ImageReaction',
  entityIdField: 'imageId',
  entityType: 'Image',
  // ...
})
```

**New topic-based handler**:
```typescript
// New way: subscribe directly to topics
export const userLoginHandler = createEventHandler({
  topics: ['app.user-login'],
  processor: async (ctx) => {
    // Process login event
  }
})
```

@meta: Removed mixed approach example - the discriminated union now prevents this at the type level.

### Phase 6: Update Event Sources & Migrate ClickHouse Handlers

**File**: `src/index.ts`

Remove ClickHouse → Debezium conversion:
```typescript
// BEFORE:
let data: DebeziumPayload;
if (topic.startsWith('clickhouse.')) {
  data = clickhouseToDebeziumFormat(parsedValue, topic);
} else {
  data = parsedValue as DebeziumPayload;
}

// AFTER:
const data = parsedValue; // Pass raw payload
eventProcessor.handleKafkaEvent(data, topic);
```

**Migrate ClickHouse handlers** to topic-based (e.g., `model-version-events.ts`):
```typescript
// BEFORE:
export const modelVersionEventsHandler = createEventHandler({
  tables: ['modelVersionEvents'],
  operations: ['create'],
  // ...
})

// AFTER:
export const modelVersionEventsHandler = createEventHandler({
  topics: ['clickhouse.modelVersionEvents'],
  // ...
})
```

This eliminates the awkward ClickHouse → Debezium transformation!

## Testing Strategy

1. **Unit tests** for handler factories with both `topics` and `tables/operations`
2. **Integration tests** ensuring legacy handlers still match correctly
3. **Migration tests** verifying new topic-based handlers work
4. Verify `handlerMapper.getStats()` reports correct counts

## Rollout Plan

1. ✅ Implement Phase 1-4 (core infrastructure)
2. ✅ Test with existing handlers (verify no regressions)
3. ✅ Add first new topic-based handler
4. ✅ Gradually migrate existing handlers if desired
5. ✅ Update documentation and examples

## Decisions

✅ **Keep `tables`/`operations` as permanent convenience helpers** - they make CDC handlers cleaner

✅ **Explicit topic lists only** - no wildcard matching needed for now

✅ **Make `old`, `current` optional in `HandlerContext`** - only populated for Debezium events
✅ **`operation` always has a value** - Debezium operation or 'create' for non-Debezium topics

## Additional Changes

### Update HandlerContext Type

```typescript
export interface HandlerContext<T = any> extends DatabaseProxies {
  old: T | null | undefined       // Only populated for Debezium
  current: T | null | undefined   // Only populated for Debezium
  record: T                       // Either after/before (Debezium) or raw payload (topic-based)
  operation: Operation            // Debezium operation or 'create' for non-Debezium
  actions: HandlerActions
}
```

### Migration Checklist

- [x] Phase 1: Update type definitions with discriminated union
- [x] Phase 2: Update handler factories (remove `canHandle`)
- [x] Phase 3: Update handler mapper
- [x] Phase 4: Update event processor (detect Debezium vs raw)
- [x] Phase 5: Migrate ClickHouse handlers to topic-based
- [x] Phase 6: Remove ClickHouse → Debezium conversion in `index.ts`
- [x] Testing: Build passes - all TypeScript compilation successful
- [ ] Documentation: Update handler development guide (future work)

