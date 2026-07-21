import { createOutboxHandler } from '../base'

export const modelHandler = createOutboxHandler({
  entityTypes: ['Model'],
  events: ['DELETED', 'PUBLISHED', 'UNPUBLISHED', 'UPDATED'],
  processor: async ({ event, entityId, actions }) => {
    actions.feedUpdate('Model', entityId, event === 'DELETED' ? 'delete' : 'update');
  }
})