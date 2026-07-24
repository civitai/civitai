import { createManualHandlerMapper } from '@/utils/handler-mapper'
import { ManualHandler } from '@/types/handlers'
import { logger } from '@/utils/logger'

// Import all manual event handlers
import { updateCompensation } from './update-compensation'

// Pre-compute manual handler mappings at module load time
const manualHandlerMapper = createManualHandlerMapper<ManualHandler>()

// Register all manual handlers
const handlers = {
  fetchCompensationHandler: updateCompensation
}

Object.entries(handlers).forEach(([name, handler]) => {
  manualHandlerMapper.register(handler, name)
})

const stats = manualHandlerMapper.getStats()
logger.info(`Pre-computed manual handler mappings: ${stats.mappings} events, ${stats.totalHandlers} total handlers`)

// Only export the getter function for looking up handlers
export function getManualHandlers(event: string): ManualHandler[] {
  return manualHandlerMapper.get(event)
}