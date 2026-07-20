import { createEventHandler } from './base'

/**
## Metrics driven by imageResourceNew table:
- ModelMetric.imageCount (create/delete)
- ModelVersionMetric.imageCount (create/delete)
*/

interface ImageResourceNewRecord {
  imageId: number
  modelVersionId: number
}

export const imageResourceHandler = createEventHandler<ImageResourceNewRecord>({
  tables: ['ImageResourceNew'],
  operations: ['create', 'delete'],
  processor: async ({ operation, record, actions, pg }) => {
    // ImageResourceNew has composite key of imageId and modelVersionId, both required
    const value = operation === 'create' ? 1 : -1

    // Get image
    const { userId } = await pg.queryOne<{ userId: number }>(
      'SELECT "userId" FROM "Image" WHERE id = $1',
      [record.imageId]
    ) ?? {}

    // Update model version metric
    const versionMetric = actions.forMetric('ModelVersion', record.modelVersionId)
    versionMetric.as(userId).add('imageCount', value)

    // Get model ID from version
    const { modelId } = await pg.queryOne<{ modelId: number }>(
      'SELECT "modelId" FROM "ModelVersion" WHERE id = $1',
      [record.modelVersionId]
    ) ?? {}

    // Update model metric
    const modelMetric = actions.forMetric('Model', modelId)
    modelMetric.as(userId).add('imageCount', value)
  },
  debug: (faker) => ({
    sample: () => ({
      imageId: faker.number.int({ min: 1, max: 1000 }),
      modelVersionId: faker.number.int({ min: 1, max: 1000 })
    }),
    pg: (sql: string) => {
      if (sql.includes('"Image"')) {
        return {
          userId: faker.number.int({ min: 1, max: 1000 })
        }
      }
      if (sql.includes('"ModelVersion"')) {
        return {
          modelId: faker.number.int({ min: 1, max: 1000 })
        }
      }
      return null;
    }
  })
})