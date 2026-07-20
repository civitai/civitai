import { createEventHandler } from './base'

/**
## Metrics driven by ResourceReview table:
- Model.ratingCount (create/delete)
- Model.rating (update when rating changes) [deprecated]
- Model.thumbsUpCount (create/update/delete when recommended=true)
- Model.thumbsDownCount (create/update/delete when recommended=false)
- ModelVersion.ratingCount (create/delete)
- ModelVersion.rating (update when rating changes) [deprecated]
- ModelVersion.thumbsUpCount (create/update/delete when recommended=true)
- ModelVersion.thumbsDownCount (create/update/delete when recommended=false)
*/

interface ResourceReviewRecord {
  modelId: number
  modelVersionId: number
  recommended: boolean
  userId: number
}

export const resourceReviewHandler = createEventHandler<ResourceReviewRecord>({
  tables: ['ResourceReview'],
  operations: ['create', 'update', 'delete'],
  processor: async ({ operation, record, current, old, actions }) => {
    // Helper to update both model and version metrics
    const modelMetric = actions.forMetric('Model', record.modelId).as(record.userId)
    const versionMetric = actions.forMetric('ModelVersion', record.modelVersionId).as(record.userId)
    const addBoth = (metricName: string, value: number) => {
      modelMetric.add(metricName, value)
      versionMetric.add(metricName, value)
    }

    // Helper to get recommendation metric name
    const getMetricType = (entity: { recommended: boolean }) =>
      entity.recommended ? 'thumbsUpCount' : 'thumbsDownCount'

    if (['create','delete'].includes(operation)) {
      const value = operation === 'create' ? 1 : -1
      const metricType = getMetricType(record);
      addBoth(metricType, value)
      addBoth('ratingCount', value)
    } else if (operation === 'update' && old && current && old?.recommended !== current?.recommended) {
      addBoth(getMetricType(old!), -1)
      addBoth(getMetricType(current!), 1)
    }
  },
  debug: (faker) => ({
    sample: () => ({
      modelId: faker.number.int({ min: 1, max: 5000 }),
      modelVersionId: faker.number.int({ min: 1, max: 5000 }),
      recommended: faker.datatype.boolean(),
      userId: faker.number.int({ min: 1, max: 1000 })
    })
  })
})