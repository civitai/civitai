import { createReactionHandler } from './base'

/**
## Metrics driven by articleReaction table:
- ArticleMetric.Like (create/delete where reaction='Like')
- ArticleMetric.Dislike (create/delete where reaction='Dislike')
- ArticleMetric.Laugh (create/delete where reaction='Laugh')
- ArticleMetric.Cry (create/delete where reaction='Cry')
- ArticleMetric.Heart (create/delete where reaction='Heart')
*/

interface ArticleReactionRecord {
  articleId: number
  userId: number
  reaction: string
}

export const articleReactionHandler = createReactionHandler<ArticleReactionRecord>({
  table:'ArticleReaction',
  entityType: 'Article',
  entityIdField: 'articleId',
  async postProcessing({ record, pg, actions }, value) {
    const { userId } = await pg.queryOne<{ postId: number | null, userId: number | null }>(
      'SELECT "userId" FROM "Article" WHERE id = $1',
      [record.articleId]
    ) ?? {};

    const ownerMetric = actions.forMetric('User', userId).as(record.userId)
    ownerMetric.add('reactionCount', value)
  },
  debug: (faker) => ({
    sample: () => ({
      articleId: faker.number.int({ min: 1, max: 5000 }),
      userId: faker.number.int({ min: 1, max: 1000 }),
      reaction: faker.helpers.arrayElement(['Like', 'Dislike', 'Heart', 'Laugh', 'Cry'])
    }),
    pg: (sql: string) => {
      if (sql.includes('"Article"')) {
        return {
          userId: faker.number.int({ min: 1, max: 1000 })
        }
      }
      return null
    }
  })
})