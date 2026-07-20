import { createEventHandler } from './base'

/**
## Metrics driven by ComicProjectEngagement table:
- ComicMetric.followerCount (type='Notify' rows)
- ComicMetric.hiddenCount (type='Hide' rows)
- ComicMetric.readerCount (rows whose readChapters is non-empty — i.e. distinct users who have read at least one chapter)
- ComicMetric.chapterReadCount (sum of readChapters length across all users — total chapters read for the project)

The PK is (userId, projectId): a single row per user/project carries both the engagement type
and the readChapters array, so we must process create/update/delete to track:
  * type transitions (Notify <-> other, Hide <-> other)
  * readChapters length delta and empty/non-empty transitions
*/

enum ComicEngagementType {
  None = 'None',
  Notify = 'Notify',
  Hide = 'Hide'
}

interface ComicProjectEngagementRecord {
  userId: number
  projectId: number
  type: ComicEngagementType
  readChapters: number[] | null
  createdAt?: Date
}

const typeMap: Partial<Record<ComicEngagementType, string>> = {
  Notify: 'followerCount',
  Hide: 'hiddenCount'
}

function readLength(record: ComicProjectEngagementRecord | null | undefined): number {
  return record?.readChapters?.length ?? 0
}

export const comicEngagementHandler = createEventHandler<ComicProjectEngagementRecord>({
  tables: ['ComicProjectEngagement'],
  operations: ['create', 'update', 'delete'],
  processor: async ({ operation, old, current, record, actions }) => {
    const comicMetric = actions.forMetric('Comic', record.projectId).as(record.userId)

    if (operation === 'create') {
      const metricType = typeMap[record.type]
      if (metricType) comicMetric.add(metricType, 1)

      const readCount = readLength(record)
      if (readCount > 0) {
        comicMetric.add('readerCount', 1)
        comicMetric.add('chapterReadCount', readCount)
      }
      return
    }

    if (operation === 'delete') {
      const metricType = typeMap[record.type]
      if (metricType) comicMetric.add(metricType, -1)

      const readCount = readLength(record)
      if (readCount > 0) {
        comicMetric.add('readerCount', -1)
        comicMetric.add('chapterReadCount', -readCount)
      }
      return
    }

    // update
    if (!old || !current) return

    if (old.type !== current.type) {
      const oldMetric = typeMap[old.type]
      if (oldMetric) comicMetric.add(oldMetric, -1)
      const newMetric = typeMap[current.type]
      if (newMetric) comicMetric.add(newMetric, 1)
    }

    const oldRead = readLength(old)
    const newRead = readLength(current)
    if (newRead !== oldRead) {
      comicMetric.add('chapterReadCount', newRead - oldRead)
    }
    if (oldRead === 0 && newRead > 0) {
      comicMetric.add('readerCount', 1)
    } else if (oldRead > 0 && newRead === 0) {
      comicMetric.add('readerCount', -1)
    }
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      projectId: faker.number.int({ min: 1, max: 5000 }),
      type: faker.helpers.arrayElement(['None', 'Notify', 'Hide'] as ComicEngagementType[]),
      readChapters: faker.helpers.maybe(
        () => Array.from(
          { length: faker.number.int({ min: 1, max: 10 }) },
          () => faker.number.int({ min: 1, max: 1000 })
        )
      ) ?? []
    })
  })
})
