import { OutboxRecord } from '@/common/services/outbox'
import { createEventHandler } from './base'
import { getOutboxHandlers } from './outbox/index'

/**
## Outbox event handler
Processes outbox events and delegates to specific entity handlers
*/
export const outboxHandler = createEventHandler<OutboxRecord>({
  tables: ['Outbox'],
  operations: ['create'],
  processor: async (ctx) => {
    const { event, entityType, entityId, details } = ctx.record;
    // Mark the outbox record as processed/deleted
    await ctx.actions.outboxRemove(ctx.record.id);

    const handlers = getOutboxHandlers(entityType, event)

    // Run all matching handlers
    for (const handler of handlers) {
      await handler.process({ ...ctx, event, entityType, entityId, details });
    }
  },
  debug: (faker) => ({
    sample: () => ({
      id: faker.number.int({ min: 1, max: 10000 }),
      event: faker.helpers.arrayElement(['PUBLISHED', 'UNPUBLISHED', 'DELETED', 'UPDATED']),
      entityType: faker.helpers.arrayElement(['Article', 'Image', 'Model', 'Post', 'ModelVersion']),
      entityId: faker.number.int({ min: 1, max: 10000 }),
      details: faker.helpers.maybe(() => ({ key: faker.lorem.word() })),
      createdAt: faker.date.past(),
    })
  })
})
