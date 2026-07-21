import { createEventHandler } from './base'

/**
## Metrics driven by bountyEntry table:
- BountyMetric.entryCount (create/delete)
*/

interface BountyEntryRecord {
  userId?: number | null
  bountyId: number
}

export const bountyEntryHandler = createEventHandler<BountyEntryRecord>({
  tables: ['BountyEntry'],
  operations: ['create', 'delete'],
  processor: async ({ operation, record, actions }) => {
    const value = operation === 'create' ? 1 : -1

    const bountyMetric = actions.forMetric('Bounty', record.bountyId).as(record.userId)
    bountyMetric.add('entryCount', value)
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.helpers.maybe(() => faker.number.int({ min: 1, max: 1000 }), { probability: 0.9 }),
      bountyId: faker.number.int({ min: 1, max: 5000 })
    })
  })
})