import {
  EventHandler,
  EventHandlerConfig,
  HandlerContext,
  DebugConfigFactory,
  OutboxHandlerConfig,
  OutboxHandler,
  ManualHandlerConfig,
  ManualHandler
} from '../types/handlers'
import { Operation } from '../types/events'

/**
 * Base handler factory that provides common patterns for metric event processing
 */
export function createEventHandler<T = any>(config: EventHandlerConfig<T>): EventHandler<T> {
  // Determine lookup keys
  let lookupKeys: string[] | undefined

  if ('topics' in config) {
    // Direct topic subscription
    lookupKeys = config.topics
  } else {
    // Legacy: generate table:operation keys
    const keys: string[] = []
    config.tables.forEach(table => {
      const normalized = table.replace('postgres.', '')
      config.operations.forEach(op => {
        keys.push(`${normalized}:${op}`)
      })
    })
    lookupKeys = keys.length > 0 ? keys : undefined
  }

  return {
    topics: lookupKeys,
    process: config.processor,
    debug: config.debug,
    tables: config.tables,
    operations: config.operations,
    metrics: config.metrics
  }
}


/**
 * Helper to create handlers for reaction-type events
 */
export interface ReactionConfig<T = any> {
  table: string
  entityType: string
  entityIdField: string
  userIdField?: string
  postProcessing?: (ctx: HandlerContext<T>, value: number) => Promise<void>
  debug?: DebugConfigFactory<T>
}

export function createReactionHandler<T = any>(config: ReactionConfig<T>) {
  return createEventHandler<T>({
    tables: [config.table],
    operations: ['create', 'delete'],
    processor: async (ctx) => {
      const { record, actions, operation } = ctx;
      const metric = actions.forMetric(config.entityType, (record as any)[config.entityIdField]).as((record as any)[config.userIdField ?? 'userId'])
      const value = operation === 'create' ? 1 : -1;
      metric.add((record as any).reaction, value);
      // MUST await: postProcessing does the PG lookup + Post/User metric adds.
      // If it floats, (1) its errors escape processEvent's try/catch and become
      // unhandled rejections that bypass the poison/transient classifier and
      // kill the process, and (2) the Kafka offset can commit before those
      // metrics are queued, silently losing them on a restart. Awaiting ties
      // the message's full work to its offset.
      await config.postProcessing?.(ctx, value);
    },
    debug: config.debug
  })
}

/**
 * Helper to create handlers for outbox events
 */
export function createOutboxHandler<TDetails = Record<string, any>>(
  config: OutboxHandlerConfig<TDetails>
): OutboxHandler<TDetails> {
  return {
    entityTypes: config.entityTypes,
    events: config.events,
    process: async (ctx) => {
      await config.processor(ctx)
    },
    debug: config.debug,
    metrics: config.metrics
  }
}

/**
 * Helper to create handlers for manual events from ClickHouse
 */
export function createManualHandler<T = any>(config: ManualHandlerConfig<T>): ManualHandler<T> {
  return {
    events: config.events,
    process: async (ctx) => {
      await config.processor(ctx)
    },
    debug: config.debug,
    metrics: config.metrics
  }
}
