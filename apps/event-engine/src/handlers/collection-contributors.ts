import { createEventHandler } from './base'

/**
## Metrics driven by collectionContributor table:
- CollectionMetric.followerCount (create/delete)
- CollectionMetric.contributorCount (create/delete)
*/

enum CollectionContributorPermission {
  VIEW = 'VIEW',
  ADD = 'ADD',
  ADD_REVIEW = 'ADD_REVIEW',
  MANAGE = 'MANAGE'
}

interface CollectionContributorRecord {
  userId: number
  collectionId: number
  permissions: CollectionContributorPermission[]
}

export const collectionContributorHandler = createEventHandler<CollectionContributorRecord>({
  tables: ['CollectionContributor'],
  operations: ['create', 'delete'],
  processor: async ({ operation, record, actions }) => {
    const value = operation === 'create' ? 1 : -1

    const collectionMetric = actions.forMetric('Collection', record.collectionId).as(record.userId)
    collectionMetric.add('followerCount', value)

    if (typeof record.permissions === 'string') {
      record.permissions = (record.permissions as string).slice(1, -1).split(',') as CollectionContributorPermission[]
    }
    // permissions can be null/undefined on a delete whose Debezium `before`
    // image omits the column (REPLICA IDENTITY not FULL). Treat as empty so a
    // missing array can't throw and wedge the whole consumer.
    const permissions = Array.isArray(record.permissions) ? record.permissions : []
    const isContributor = permissions.some((p) => p !== CollectionContributorPermission.VIEW);
    if (isContributor) collectionMetric.add('contributorCount', value)
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      collectionId: faker.number.int({ min: 1, max: 5000 }),
      permissions: faker.helpers.arrayElements(
        ['VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE'] as CollectionContributorPermission[],
        faker.number.int({ min: 1, max: 3 })
      )
    })
  })
})