import { logger } from '@/utils/logger';
import { createEventHandler } from './base'
import { getManualHandlers } from './manual/index'

interface ManualEventRecord {
  date: Date;
  event: string;
  data: string;
}

/**
## Manual event handler
Processes manual events from ClickHouse Kafka topic and delegates to specific handlers
*/
export const manualHandler = createEventHandler<ManualEventRecord>({
  topics: ['clickhouse.manual_events'],
  processor: async (ctx) => {
    const { event, data } = ctx.record;

    // Parse the JSON data
    let parsedData: any;
    try {
      parsedData = JSON.parse(data);
    } catch (err) {
      logger.error({ err, data }, 'Failed to parse manual event data');
      return;
    }

    const handlers = getManualHandlers(event);

    // Run all matching handlers
    for (const handler of handlers) {
      await handler.process({ ...ctx, event, data: parsedData });
    }
  },
  // TODO: This isn't actually helpful right now...
  debug: (faker) => ({
    sample: () => ({
      date: faker.date.recent(),
      event: faker.helpers.arrayElement(['fetch-compensation', 'recalculate-metrics', 'sync-cache']),
      data: JSON.stringify({
        entityId: faker.number.int({ min: 1, max: 10000 }),
        timestamp: faker.date.recent().toISOString()
      })
    })
  })
})