import { createReactionHandler } from './base';

/**
## Metrics driven by bountyEntryReaction table:
- BountyEntryMetric.Like (create/delete where reaction='Like')
- BountyEntryMetric.Dislike (create/delete where reaction='Dislike')
- BountyEntryMetric.Laugh (create/delete where reaction='Laugh')
- BountyEntryMetric.Cry (create/delete where reaction='Cry')
- BountyEntryMetric.Heart (create/delete where reaction='Heart')
*/

interface BountyEntryReactionRecord {
  bountyEntryId: number
  userId: number
  reaction: string
}

export const bountyEntryReactionHandler = createReactionHandler<BountyEntryReactionRecord>({
  table: 'BountyEntryReaction',
  entityType: 'BountyEntry',
  entityIdField: 'bountyEntryId',
  async postProcessing({ record, pg, actions }, value) {
    const { userId } = await pg.queryOne<{ postId: number | null, userId: number | null }>(
      'SELECT "userId" FROM "BountyEntry" WHERE id = $1',
      [record.bountyEntryId]
    ) ?? {};

    const ownerMetric = actions.forMetric('User', userId).as(record.userId)
    ownerMetric.add('reactionCount', value)
  },
  debug: (faker) => ({
    sample: () => ({
      bountyEntryId: faker.number.int({ min: 1, max: 5000 }),
      userId: faker.number.int({ min: 1, max: 1000 }),
      reaction: faker.helpers.arrayElement(['Like', 'Dislike', 'Heart', 'Laugh', 'Cry'])
    }),
    pg: (sql: string) => {
      if (sql.includes('"BountyEntry"')) {
        return {
          userId: faker.number.int({ min: 1, max: 1000 })
        }
      }
      return null
    }
  })
})
