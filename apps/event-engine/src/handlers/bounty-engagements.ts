import { createEventHandler } from './base'

/**
## Metrics driven by bountyEngagement table:
- BountyMetric.favoriteCount (create/delete where type='Favorite')
- BountyMetric.trackCount (create/delete where type='Track')
*/

enum BountyEngagementType {
  Favorite = 'Favorite',
  Track = 'Track'
}

interface BountyEngagementRecord {
  userId: number
  bountyId: number
  type: BountyEngagementType
}

const typeMap: Record<BountyEngagementType, string> = {
  Favorite: 'favoriteCount',
  Track: 'trackCount'
}

export const bountyEngagementHandler = createEventHandler<BountyEngagementRecord>({
  tables: ['BountyEngagement'],
  operations: ['create', 'delete'],
  processor: async ({ operation, record, actions }) => {
    const value = operation === 'create' ? 1 : -1

    const bountyMetric = actions.forMetric('Bounty', record.bountyId).as(record.userId)
    const metricType = typeMap[record.type]
    if (metricType) bountyMetric.add(metricType, value)
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      bountyId: faker.number.int({ min: 1, max: 5000 }),
      type: faker.helpers.arrayElement(['Favorite', 'Track'] as BountyEngagementType[])
    })
  })
})