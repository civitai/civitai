import { EventHandler } from '../types/handlers'

// Import all handlers
import { userEngagementHandler } from './user-engagement'
import { imageReactionHandler } from './image-reactions'
import { articleReactionHandler } from './article-reactions'
import { articleHandler } from './article'
import { bountyEntryReactionHandler } from './bounty-entry-reactions'
import { resourceReviewHandler } from './reviews'
import { collectionItemHandler } from './collection-items'
import { collectionContributorHandler } from './collection-contributors'
import { commentHandler } from './comments'
import { commentV2Handler } from './comment-v2'
import { imageResourceHandler } from './image-resources'
import { buzzTipHandler } from './buzz-tips'
import { tagEngagementHandler } from './tag-engagements'
import { bountyEngagementHandler } from './bounty-engagements'
import { comicEngagementHandler } from './comic-engagements'
import { bountyEntryHandler } from './bounty-entries'
import { bountyBenefactorHandler } from './bounty-benefactors'
import { bountyHandler } from './bounty'
import { tagsHandler } from './tags'
import { modelVersionEventsHandler } from './model-version-events'
import { jobsHandler } from './jobs'
import { manualHandler } from './manual'
import { outboxHandler } from './outbox'

/**
 * Registry of all event handlers
 * pass in raw handler as key and value
 */
export const eventHandlers: Record<string, EventHandler> = {
  // User metrics
  userEngagementHandler,

  // Reactions
  imageReactionHandler,
  articleReactionHandler,
  bountyEntryReactionHandler,

  // Article updates
  articleHandler,

  // Reviews
  resourceReviewHandler,

  // Collections
  collectionItemHandler,
  collectionContributorHandler,

  // Comments
  commentHandler,
  commentV2Handler,

  // Images
  imageResourceHandler,

  // Tips and buzz
  buzzTipHandler,

  // Tags
  tagEngagementHandler,
  tagsHandler,

  // Engagements
  bountyEngagementHandler,
  comicEngagementHandler,

  // Bounties
  bountyHandler,
  bountyEntryHandler,
  bountyBenefactorHandler,

  // Outbox pattern (delegates to entity-specific handlers)
  outboxHandler,

  // ClickHouse event handlers
  modelVersionEventsHandler,
  jobsHandler,

  // Manual event handlers (from ClickHouse Kafka topic)
  manualHandler
}

/**
 * Get all handlers as an array
 */
export function getAllHandlers(): EventHandler[] {
  return Object.values(eventHandlers)
}

/**
 * Get handler by name
 */
export function getHandler(name: string): EventHandler | undefined {
  return eventHandlers[name]
}

/**
 * Find handlers that can process a specific table and operation
 * Note: This is deprecated - use HandlerMapper.get() instead for O(1) lookup
 */
export function findHandlers(table: string, operation: string): EventHandler[] {
  const key = `${table.replace('postgres.', '')}:${operation}`
  return getAllHandlers().filter(handler =>
    handler.topics?.includes(key)
  )
}