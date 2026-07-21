import { createEventHandler } from './base'

/**
## Metrics driven by bountyBenefactor table:
- BountyMetric.benefactorCount (create/delete)
- BountyMetric.unitAmount (create/delete/update) [renamed]
- BountyEntryMetric.unitAmount (update only when awardedToId changes) [renamed]
*/

interface BountyBenefactorRecord {
  userId: number
  bountyId: number
  unitAmount: number
  awardedToId?: number | null
}

export const bountyBenefactorHandler = createEventHandler<BountyBenefactorRecord>({
  tables: ['BountyBenefactor'],
  operations: ['create', 'update', 'delete'],
  processor: async ({ operation, record, current, old, actions }) => {
    if (['create','delete'].includes(operation)) {
      const value = operation === 'create' ? 1 : -1
      const amount = value * (record.unitAmount || 0)
      // Update bounty metrics
      const bountyMetric = actions.forMetric('Bounty', record.bountyId).as(record.userId)
      bountyMetric.add('benefactorCount', value)
      bountyMetric.add('unitAmount', amount)

      const entryMetric = actions.forMetric('BountyEntry', record.awardedToId).as(record.userId)
      entryMetric.add('unitAmount', amount)
    }

    if (operation === 'update' && current && old) {
      // Handle unitAmount changes
      const unitAmountDiff = (current.unitAmount || 0) - (old.unitAmount || 0)
      if (unitAmountDiff !== 0) {
        const bountyMetric = actions.forMetric('Bounty', current.bountyId).as(current.userId)
        bountyMetric.add('unitAmount', unitAmountDiff)
      }

      // Handle awardedToId changes
      if (old.awardedToId !== current.awardedToId) {
        // Remove from old entry
        const oldEntryMetric = actions.forMetric('BountyEntry', old.awardedToId).as(current.userId)
        oldEntryMetric.add('unitAmount', -(old.unitAmount || 0))
        // Add to new entry
        const newEntryMetric = actions.forMetric('BountyEntry', current.awardedToId).as(current.userId)
        newEntryMetric.add('unitAmount', current.unitAmount || 0)
      }
    }
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      bountyId: faker.number.int({ min: 1, max: 5000 }),
      unitAmount: faker.number.int({ min: 100, max: 10000 }),
      awardedToId: faker.helpers.maybe(() => faker.number.int({ min: 1, max: 1000 }), { probability: 0.3 })
    })
  })
})