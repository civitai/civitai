import { createEventHandler } from './base'

interface Article {
  id: number
  status: 'Draft' | 'Published' | 'Unpublished'
  userId: number
}

export const articleHandler = createEventHandler<Article>({
  tables: ['Article'],
  operations: ['update', 'delete'],
  processor: async ({ old, current, actions, operation, record }) => {
    // Handle delete operation
    if (operation === 'delete') {
      actions.feedDelete('Article', record.id)
      current = {...record, status: 'Unpublished'} // Treat deleted as Unpublished for metrics
    }
    if (!old || !current) return

    // Only run if we're changing between Published and non-Published states
    const states = [current.status, old.status];
    if (!states.includes('Published')) return;

    // If status changed, update feeds and articleCount metric
    if (old.status !== current.status) {
      if (operation !== 'delete')
        actions.feedUpdate('Article', current.id)

      // Track articleCount metric
      const value = current.status === 'Published' ? 1 : -1
      const userMetric = actions.forMetric('User', current.userId).as(current.userId)
      userMetric.add('articleCount', value)
    }
  },
  debug: (faker) => ({
    sample: () => ({
      id: faker.number.int({ min: 1, max: 10000 }),
      status: faker.helpers.arrayElement(['Draft', 'Published', 'Unpublished']),
      userId: faker.number.int({ min: 1, max: 1000 })
    })
  })
})