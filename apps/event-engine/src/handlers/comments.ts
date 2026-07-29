import { createEventHandler } from './base'

/**
## Metrics driven by comment table:
- ModelMetric.commentCount (create/delete)
- ModelVersionMetric.commentCount (create/delete)
*/

interface CommentRecord {
  userId: number
  modelId: number
}

export const commentHandler = createEventHandler<CommentRecord>({
  tables: ['Comment'],
  operations: ['create', 'delete'],
  processor: async ({ operation, record, actions }) => {
    const value = operation === 'create' ? 1 : -1

    // Update model metric
    const modelMetric = actions.forMetric('Model', record.modelId).as(record.userId)
    modelMetric.add('commentCount', value)
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      modelId: faker.number.int({ min: 1, max: 1000 })
    })
  })
})