import { createEventHandler } from './base'

interface Bounty {
  id: number
  userId: number | null
}

export const bountyHandler = createEventHandler<Bounty>({
  tables: ['Bounty'],
  operations: ['create', 'update', 'delete'],
  processor: async ({ operation, record, actions }) => {
    // Update user's bounty count if creating/deleting
    if (operation !== 'update') {
      const userMetric = actions.forMetric('User', record.userId).as(record.userId)
      const value = operation === 'create' ? 1 : -1
      userMetric.add('bountyCount', value)
    }
  },
  debug: (faker) => ({
    sample: () => ({
      id: faker.number.int({ min: 1, max: 10000 }),
      userId: faker.number.int({ min: 1, max: 1000 })
    })
  })
})