import { createOutboxHandlerMapper } from '@/utils/handler-mapper'
import { OutboxHandler } from '@/types/handlers'
import { logger } from '@/utils/logger'

// Import all handlers
import { modelVersionHandler } from './model-version'
import { modelHandler } from './model'
import { postHandler } from './post'

// Pre-compute outbox handler mappings at module load time
const outboxHandlerMapper = createOutboxHandlerMapper<OutboxHandler<any>>()

// Register all outbox handlers
const handlers = {
  modelVersionHandler,
  modelHandler,
  postHandler
}

Object.entries(handlers).forEach(([name, handler]) => {
  outboxHandlerMapper.register(handler, name)
})

const stats = outboxHandlerMapper.getStats()
logger.info(`Pre-computed outbox handler mappings: ${stats.mappings} combinations, ${stats.totalHandlers} total handlers`)

// Only export the getter function for looking up handlers
export function getOutboxHandlers(entityType: string, event: string): OutboxHandler<any>[] {
  const key = `${entityType}:${event}`
  return outboxHandlerMapper.get(key)
}
