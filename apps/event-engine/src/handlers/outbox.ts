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
    const { id, event, entityType, entityId, details } = ctx.record;

    const handlers = getOutboxHandlers(entityType, event)

    // Run every matching handler FIRST, then drain (below). If a handler throws
    // we never reach outboxRemove, so the row survives: the Kafka message isn't
    // committed and redelivers (at-least-once), and the OutboxPoller can reconcile
    // the row as a backstop. Removing the row before the handlers ran would drop
    // the work on any handler failure — including poison-skipped messages — with
    // nothing left for the poller to retry. Handlers are idempotent, so
    // re-running on redelivery is safe.
    for (const handler of handlers) {
      await handler.process({ ...ctx, event, entityType, entityId, details });
    }

    // Drain only after every handler succeeded.
    await ctx.actions.outboxRemove(id);
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
