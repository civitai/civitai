import { createEventHandler } from './base'

/**
## Metrics driven by buzzTip table:
- ModelMetric.tippedCount (create)
- ModelMetric.tippedAmountCount (create)
- ModelVersionMetric.tippedCount (create) [deprecated]
- ModelVersionMetric.tippedAmountCount (create) [deprecated]
- ImageMetric.tippedCount (create)
- ImageMetric.tippedAmountCount (create)
- ArticleMetric.tippedCount (create)
- ArticleMetric.tippedAmountCount (create)
- PostMetric.tippedCount (create) [new]
- PostMetric.tippedAmountCount (create) [new]
- BountyEntryMetric.tippedCount (create) [deprecated]
- BountyEntryMetric.tippedAmountCount (create) [deprecated]
- UserMetric.tippedCount (create) [new]
- UserMetric.tippedAmountCount (create) [new]
*/

type EntityType = 'Article' | 'Image' | 'Model' | 'Post' | 'Comic'

interface BuzzTipRecord {
  entityType: EntityType
  entityId: number
  toUserId: number
  fromUserId: number
  amount: number
}

export const buzzTipHandler = createEventHandler<BuzzTipRecord>({
  tables: ['BuzzTip'],
  operations: ['create', 'update'],
  processor: async ({ record, old, operation, actions }) => {
    // BuzzTip is keyed (entityType, entityId, fromUserId), so a repeat tip from the
    // same user to the same entity is an UPDATE that accumulates `amount` in place.
    // Without handling updates we silently drop every tip after a user's first one.
    // On update we count only the incremental tip: after.amount - before.amount.
    // before.amount is only present when BuzzTip is REPLICA IDENTITY FULL; until that
    // DDL is applied, old.amount is undefined and we skip (matching prior behavior)
    // rather than re-adding the full accumulated total.
    const amount =
      operation === 'create'
        ? record.amount
        : typeof old?.amount === 'number'
        ? record.amount - old.amount
        : NaN

    if (!(amount > 0)) return

    const entityMetric = actions.forMetric(record.entityType, record.entityId).as(record.fromUserId)
    entityMetric.add('tippedCount', 1)
    entityMetric.add('tippedAmount', amount)

    const targetUserMetric = actions.forMetric('User', record.toUserId).as(record.fromUserId)
    targetUserMetric.add('tippedCount', 1)
    targetUserMetric.add('tippedAmount', amount)

    const fromUserMetric = actions.forMetric('User', record.fromUserId).as(record.fromUserId)
    fromUserMetric.add('tipsGivenCount', 1)
    fromUserMetric.add('tipsGivenAmount', amount)
  },
  debug: (faker) => ({
    sample: () => ({
      entityType: faker.helpers.arrayElement(['Article', 'Image', 'Model', 'Post', 'Comic'] as EntityType[]),
      entityId: faker.number.int({ min: 1, max: 5000 }),
      toUserId: faker.number.int({ min: 1, max: 1000 }),
      fromUserId: faker.number.int({ min: 1, max: 1000 }),
      amount: faker.number.int({ min: 10, max: 1000 })
    })
  })
})