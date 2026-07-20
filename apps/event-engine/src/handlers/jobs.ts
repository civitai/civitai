import { logger } from '@/utils/logger'
import { createEventHandler } from './base'

/**
## Metrics driven by jobs (ClickHouse):
- ModelMetric.generationCount (job completion)
- ModelVersionMetric.generationCount (job completion)
*/

interface JobRecord {
  userId: number
  jobType: string
  remixOfId: number | null
  resourcesUsed: number[]
  blobsCount: number
}

export const jobsHandler = createEventHandler<JobRecord>({
  topics: ['clickhouse.jobs'],
  processor: async ({ record, actions, pg }) => {
    const generatedCount = record?.blobsCount || 1

    // Remix metrics
    if (record?.remixOfId) {
      const imageMetric = actions.forMetric('Image', record.remixOfId).as(record.userId)
      imageMetric.add('remixCount', generatedCount)

      // Get userId of the original image to attribute the remix to them
      try {
        const { userId: originalUserId } = await pg.queryOne<{ userId: number }>(
          'SELECT "userId" FROM "Image" WHERE id = $1',
          [record.remixOfId]
        ) ?? {}
        const userMetric = actions.forMetric('User', originalUserId).as(record.userId)
        userMetric.add('remixCount', generatedCount)
      } catch (err) {
        // Log and continue - we don't want to block the main job processing
        logger.error({ err, imageId: record.remixOfId }, 'Failed to fetch original image userId for remix metrics')
      }
    }

    // Generation metrics
    if (!record?.resourcesUsed || record.resourcesUsed.length === 0) return

    // Process each resource (modelVersion) used in the job
    for (const modelVersionId of record.resourcesUsed) {
      // Update ModelVersion generation count
      const modelVersionMetric = actions.forMetric('ModelVersion', modelVersionId).as(record.userId)
      modelVersionMetric.add('generationCount', generatedCount)

      // Fetch model ID for this version to update Model metrics
      const { modelId } = await pg.queryOne<{ modelId: number }>(
        'SELECT "modelId" FROM "ModelVersion" WHERE id = $1',
        [modelVersionId]
      ) ?? {}

      // Update Model generation count
      const modelMetric = actions.forMetric('Model', modelId).as(record.userId)
      modelMetric.add('generationCount', generatedCount)
    }
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      jobType: faker.helpers.arrayElement(['TextToImageV2', 'TextToImage', 'Comfy']),
      remixOfId: faker.datatype.boolean() ? faker.number.int({ min: 1, max: 1000 }) : null,
      resourcesUsed: Array.from({ length: faker.number.int({ min: 1, max: 3 }) },
        () => faker.number.int({ min: 1, max: 10000 })),
      blobsCount: faker.number.int({ min: 1, max: 4 })
    }),
    pg: (sql: string) => {
      if (sql.includes('"ModelVersion"')) {
        return { modelId: faker.number.int({ min: 1, max: 5000 }) }
      }
      if (sql.includes('"Image"')) {
        return { userId: faker.number.int({ min: 1, max: 5000 }) }
      }
      return null
    }
  })
})