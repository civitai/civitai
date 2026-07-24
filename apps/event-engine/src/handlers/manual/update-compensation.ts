import { CacheUpdate } from '@/types/events';
import { createManualHandler } from '@/handlers/base'
import { logger } from '@/utils/logger'

// Type definition for compensation fetch data
interface FetchCompensationData {
  date: string
}

/**
## Fetch Compensation Handler
Demo handler for processing compensation fetch events from ClickHouse manual events
*/
export const updateCompensation = createManualHandler<FetchCompensationData>({
  events: ['update-compensation'],
  processor: async ({ data, actions, ch, pg }) => {
    const metricEventQuery = `
      SELECT
        'ModelVersion' as entity,
        modelVersionId as entityId,
        0 as userId,
        'earnedAmount' as metricType,
        floor(SUM(amount)) as metricValue,
        toDate('${data.date}') as createdAt
      FROM orchestration.resourceCompensations
      WHERE date = '${data.date}'
      GROUP BY modelVersionId;
    `

    // Insert the metrics into Clickhouse
    logger.info(`Inserting compensation metrics for date ${data.date}`)
    await ch.query(`
      INSERT INTO default.entityMetricEvents
      (
        entityType,
        entityId,
        userId,
        metricType,
        metricValue,
        createdAt
      )
      ${metricEventQuery}
    `)

    // Now fetch to update cache
    logger.info(`Fetching compensation data for cache update`)
    const compensation = await ch.query<CacheUpdate>(metricEventQuery)
    logger.info(`Compensation data fetched: ${compensation.length} records`)

    // Calling with bulk will pipeline and skip signals for performance
    actions.incMetricCache(compensation)
    logger.info(`Compensation cache updated: ${compensation.length} records`)

    // Get Models and earnings
    const modelVersionIds = [...new Set(compensation.map(c => c.entityId))].filter(Boolean)
    const models = await pg.query<{modelVersionId: number, modelId: number}>(`
      SELECT "modelId", "id" as "modelVersionId" FROM "ModelVersion" WHERE id = ANY($1)
    `, [modelVersionIds]);
    const modelsMap = new Map(models.map(m => [m.modelVersionId, m.modelId]));
    const modelEarnings: Record<number, number> = {};
    for (const comp of compensation) {
      const modelId = modelsMap.get(comp.entityId);
      if (!modelId) continue;
      if (!modelEarnings[modelId]) modelEarnings[modelId] = 0;
      modelEarnings[modelId] += comp.metricValue;
    }

    // Insert Model earnings
    const modelEarningsEntries = Object.entries(modelEarnings).map(([modelId, metricValue]) => ({
      entityType: 'Model',
      entityId: Number(modelId),
      userId: 0,
      metricType: 'earnedAmount',
      metricValue,
      createdAt: new Date()
    }));
    await ch.insert('default.entityMetricEvents', modelEarningsEntries);
    actions.incMetricCache(modelEarningsEntries);

  },
  debug: (faker) => ({
    sample: () => ({
      date: faker.date.recent(),
      event: 'update-compensation',
      data: JSON.stringify({
        date: faker.date.recent().toISOString().split('T')[0]
      })
    })
  }),
  metrics: {
    'Model': ['earnedAmount'],
    'ModelVersion': ['earnedAmount']
  }
});