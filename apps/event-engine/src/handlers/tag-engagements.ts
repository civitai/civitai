import { createEventHandler } from './base'

/**
## Metrics driven by tagEngagement table:
- TagMetric.hiddenCount (create/delete where type='Hide')
- TagMetric.followerCount (create/delete where type='Follow')
*/

enum TagEngagementType {
  Hide = 'Hide',
  Follow = 'Follow',
  Allow = 'Allow'
}

interface TagEngagementRecord {
  userId: number
  tagId: number
  type: TagEngagementType
  createdAt?: Date
}

const typeMap: Partial<Record<TagEngagementType, string>> = {
  Hide: 'hiddenCount',
  Follow: 'followerCount'
}

export const tagEngagementHandler = createEventHandler<TagEngagementRecord>({
  tables: ['TagEngagement'],
  operations: ['create', 'delete'],
  processor: async ({ operation, record, actions }) => {
    const value = operation === 'create' ? 1 : -1

    const tagMetric = actions.forMetric('Tag', record.tagId).as(record.userId)
    const metricType = typeMap[record.type]
    if (metricType) tagMetric.add(metricType, value)
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      tagId: faker.number.int({ min: 1, max: 5000 }),
      type: faker.helpers.arrayElement(['Hide', 'Follow', 'Allow'] as TagEngagementType[])
    })
  })
})