import { createEventHandler } from './base'

/**
## Metrics driven by modelVersionEvents (ClickHouse):
- ModelMetric.downloadCount (download event)
- ModelVersionMetric.downloadCount (download event)
*/

interface ModelVersionEventRecord {
  modelId: number
  modelVersionId: number
  userId: number
}

export const modelVersionEventsHandler = createEventHandler<ModelVersionEventRecord>({
  topics: ['clickhouse.modelVersionEvents'],
  processor: async ({ record, actions }) => {
    // Update Model download count
    const modelMetric = actions.forMetric('Model', record.modelId).as(record.userId)
    modelMetric.add('downloadCount', 1)

    // Update ModelVersion download count
    const modelVersionMetric = actions.forMetric('ModelVersion', record.modelVersionId).as(record.userId)
    modelVersionMetric.add('downloadCount', 1)
  },
  debug: (faker) => ({
    sample: () => ({
      modelId: faker.number.int({ min: 1, max: 5000 }),
      modelVersionId: faker.number.int({ min: 1, max: 10000 }),
      userId: faker.number.int({ min: 1, max: 1000 })
    })
  })
})