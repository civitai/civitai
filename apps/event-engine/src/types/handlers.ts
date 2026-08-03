import { MetricEvent, CacheUpdate, FeedUpdate, Operation } from './events'
import { OutboxRecord } from '@/common/services/outbox'
import { SpineWorkflowRequest } from './spine'

export interface DatabaseProxies {
  pg: {
    query: <T = any>(sql: string, params?: any[]) => Promise<T[]>
    queryOne: <T = any>(sql: string, params?: any[]) => Promise<T | null>
    exec: (sql: string, params?: any[]) => Promise<number>
  }
  ch: {
    query: <T = any>(sql: string) => Promise<T[]>
    insert: (table: string, data: any[]) => Promise<void>
  }
}

export interface MetricBuilder {
  as: (userId: MetricEvent['userId']) => {
    add: (metricType: MetricEvent['metricType'], value?: number) => void
    remove: (metricType: MetricEvent['metricType'], value?: number) => void
  }
}

export type FeedUpdateType = 'update' | 'delete' | 'metricUpdate'

export interface HandlerActions {
  addMetricEvent: (event: MetricEvent) => void
  incMetricCache: (update: CacheUpdate | CacheUpdate[]) => Promise<void>
  forMetric: (entityType: MetricEvent['entityType'], entityId: MetricEvent['entityId']) => MetricBuilder
  feedUpdate: (entityType: FeedUpdate['entityType'], entityId: FeedUpdate['entityId'], type?: FeedUpdateType) => void
  feedDelete: (entityType: FeedUpdate['entityType'], entityId: FeedUpdate['entityId']) => void
  feedMetricUpdate: (entityType: FeedUpdate['entityType'], entityId: FeedUpdate['entityId']) => void
  outboxRemove: (id: number) => Promise<void>
  spine: {
    req: (request: SpineWorkflowRequest) => Promise<void>
  }
}

export interface HandlerContext<T = any> extends DatabaseProxies {
  old: T | null | undefined       // Only populated for Debezium
  current: T | null | undefined   // Only populated for Debezium
  record: T                       // Either after/before (Debezium) or raw payload (topic-based)
  operation: Operation            // Debezium operation or 'create' for non-Debezium
  actions: HandlerActions
}

export interface DebugConfig<T = any> {
  sample: () => T  // This already returns T, which is good
  pg?: (sql: string, params?: any[]) => any | null
  ch?: (sql: string) => any[] | null
}

// Stubbed faker type with just the methods we use in handlers
export interface FakerStub {
  number: {
    int(options?: { min?: number; max?: number }): number
    float(options?: { min?: number; max?: number }): number
  }
  string: {
    uuid(): string
    alphanumeric(length?: number): string
  }
  datatype: {
    boolean(): boolean
  }
  date: {
    past(): Date
    recent(): Date
    future(): Date
  }
  lorem: {
    sentence(): string
    paragraph(): string
    word(): string
  }
  image: {
    url(): string
  }
  helpers: {
    arrayElement<T>(array: ReadonlyArray<T>): T
    arrayElements<T>(array: ReadonlyArray<T>, count?: number | { min?: number; max?: number }): T[]
    maybe<T>(fn: () => T, options?: { probability?: number }): T | undefined
  }
}

export type DebugConfigFactory<T = any> = (faker: FakerStub) => DebugConfig<T>

// Discriminated union: must use EITHER topics OR tables+operations
export type EventHandlerConfig<T = any> = {
  processor: (ctx: HandlerContext<T>) => Promise<void>
  debug?: DebugConfigFactory<T>
  metrics?: Record<string, string[]>
} & (
  | { topics: string[]; tables?: never; operations?: never }          // Topic-based
  | { tables: string[]; operations: Operation[]; topics?: never }     // Legacy CDC
)

export interface EventHandler<T = any> {
  topics?: string[]  // Lookup keys for handler mapper
  process: (ctx: HandlerContext<T>) => Promise<void>
  debug?: DebugConfigFactory<T>
  tables?: string[]
  operations?: Operation[]
  metrics?: Record<string, string[]>
}

export interface QueuedTask {
  id: string
  event: any
  handlerName: string
  retries: number
  maxRetries?: number
  timestamp: Date
}

/**
 * Configuration for outbox event handlers
 */
export interface OutboxHandlerConfig<TDetails = Record<string, any>> {
  entityTypes: OutboxRecord<TDetails>['entityType'][]
  events: string[]
  processor: (ctx: HandlerContext<OutboxRecord<TDetails>> & {
    event: string
    entityType: string
    entityId: number
    details?: TDetails | null
  }) => Promise<void>
  debug?: DebugConfigFactory<OutboxRecord<TDetails>>
  metrics?: Record<string, string[]>
}

/**
 * Outbox event handler type
 */
export interface OutboxHandler<TDetails = Record<string, any>> {
  entityTypes: string[]
  events: string[]
  process: (ctx: HandlerContext<OutboxRecord<TDetails>> & {
    event: string
    entityType: string
    entityId: number
    details?: TDetails | null
  }) => Promise<void>
  debug?: DebugConfigFactory<OutboxRecord<TDetails>>
  metrics?: Record<string, string[]>
}

/**
 * Manual event record from ClickHouse Kafka topic
 */
export interface ManualEventRecord {
  date: Date
  event: string
  data: string
}

/**
 * Configuration for manual event handlers
 */
export interface ManualHandlerConfig<T = any> {
  events: string[]
  processor: (ctx: HandlerContext<ManualEventRecord> & {
    event: string
    data: T
  }) => Promise<void>
  debug?: DebugConfigFactory<ManualEventRecord>
  metrics?: Record<string, string[]>
}

/**
 * Manual event handler type
 */
export interface ManualHandler<T = any> {
  events: string[]
  process: (ctx: HandlerContext<ManualEventRecord> & {
    event: string
    data: T
  }) => Promise<void>
  debug?: DebugConfigFactory<ManualEventRecord>
  metrics?: Record<string, string[]>
}
