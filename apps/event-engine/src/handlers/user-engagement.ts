import { createEventHandler } from './base'

/**
## Metrics driven by userEngagement table:
- UserMetric.followingCount (create/delete where type='Follow')
- UserMetric.followerCount (create/delete where type='Follow')
- UserMetric.hiddenCount (create/delete where type='Hide')
*/

enum UserEngagementType {
  Follow = 'Follow',
  Hide = 'Hide',
  Block = 'Block'
}

interface UserEngagementRecord {
  userId: number
  targetUserId: number
  type: UserEngagementType
  createdAt?: Date
}

export const userEngagementHandler = createEventHandler<UserEngagementRecord>({
  tables: ['UserEngagement'],
  operations: ['create', 'delete'],
  async processor({ operation, record, actions }) {
    const value = operation === 'create' ? 1 : -1

    const targetMetric = actions.forMetric('User', record.targetUserId).as(record.userId)
    const actorMetric = actions.forMetric('User', record.userId).as(record.userId)

    if (record.type === UserEngagementType.Follow) {
      // User who is following gets +1 to followingCount
      actorMetric.add('followingCount', value)

      // User being followed gets +1 to followerCount
      targetMetric.add('followerCount', value)
    } else if (record.type === UserEngagementType.Hide) {
      // User who is hidden gets +1 to hiddenCount
      targetMetric.add('hiddenCount', value)
    }
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      targetUserId: faker.number.int({ min: 1, max: 1000 }),
      type: faker.helpers.arrayElement(['Follow', 'Hide', 'Block'] as UserEngagementType[])
    })
  })
})