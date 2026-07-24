import { logger } from '@/utils/logger'

export interface MappableHandler {
  topics?: string[]    // NEW: Direct topic support
  tables?: string[]
  operations?: string[]
}

export interface OutboxMappableHandler {
  entityTypes: string[]
  events: (string | '*')[]
}

/**
 * Generic handler mapper that pre-computes lookups for O(1) access
 */
export class HandlerMapper<T> {
  private map: Map<string, T[]> = new Map()
  private wildcardHandlers: T[] = []

  constructor(
    private readonly keyBuilder: (handler: T) => string[] | null,
    private readonly handlerName?: (handler: T) => string
  ) {}

  /**
   * Register a handler with its lookup keys
   */
  register(handler: T, name?: string): void {
    const keys = this.keyBuilder(handler)

    if (!keys) {
      const handlerLabel = name || this.handlerName?.(handler) || 'unknown'
      logger.warn(`Handler ${handlerLabel} could not generate lookup keys`)
      return
    }

    // Check for wildcard patterns
    if (keys.includes('*')) {
      this.wildcardHandlers.push(handler)
      return
    }

    // Register normal keys
    keys.forEach(key => {
      if (!this.map.has(key)) {
        this.map.set(key, [])
      }
      this.map.get(key)!.push(handler)
    })
  }

  /**
   * Get handlers for a given key
   */
  get(key: string): T[] {
    const specific = this.map.get(key) || []
    return [...specific, ...this.wildcardHandlers]
  }

  /**
   * Get statistics about the mapper
   */
  getStats() {
    return {
      mappings: this.map.size,
      wildcardHandlers: this.wildcardHandlers.length,
      totalHandlers: Array.from(this.map.values()).reduce((sum, handlers) => sum + handlers.length, 0) + this.wildcardHandlers.length
    }
  }

  /**
   * Clear all mappings
   */
  clear(): void {
    this.map.clear()
    this.wildcardHandlers = []
  }
}

/**
 * Create a handler mapper for event handlers (topic-based or table:operation mapping)
 * Expects objects with a 'handler' property that contains topics or tables/operations
 */
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

/**
 * Create a handler mapper for outbox handlers (entityType:event mapping)
 */
export function createOutboxHandlerMapper<T extends OutboxMappableHandler>() {
  return new HandlerMapper<T>(
    (handler) => {
      const keys: string[] = []

      // Check for wildcard events
      if (handler.events.includes('*')) {
        return ['*'] // This handler matches everything
      }

      handler.entityTypes.forEach(entityType => {
        handler.events.forEach(event => {
          if (event !== '*') {
            keys.push(`${entityType}:${event}`)
          }
        })
      })
      return keys
    }
  )
}

export interface ManualMappableHandler {
  events: string[]
}

/**
 * Create a handler mapper for manual handlers (event mapping)
 */
export function createManualHandlerMapper<T extends ManualMappableHandler>() {
  return new HandlerMapper<T>(
    (handler) => {
      // Manual handlers just map by event name
      return handler.events
    }
  )
}