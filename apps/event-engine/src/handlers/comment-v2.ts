import { createEventHandler } from './base'

/**
## Metrics driven by commentv2 table:
- PostMetric.commentCount (create/delete)
- ImageMetric.commentCount (create/delete)
- ArticleMetric.commentCount (create/delete)
- BountyMetric.commentCount (create/delete)
*/

interface CommentV2Record {
  userId: number
  threadId: number
}

export const commentV2Handler = createEventHandler<CommentV2Record>({
  tables: ['CommentV2'],
  operations: ['create', 'delete'],
  processor: async ({ operation, record, actions, pg }) => {
    const value = operation === 'create' ? 1 : -1

    // Get thread details to identify entity type and ID
    const thread = await pg.queryOne<{
      postId: number | null
      imageId: number | null
      articleId: number | null
      bountyId: number | null
    }>(
      `SELECT
        COALESCE(r."postId", t."postId") AS "postId",
        COALESCE(r."imageId", t."imageId") AS "imageId",
        COALESCE(r."articleId", t."articleId") AS "articleId",
        COALESCE(r."bountyId", t."bountyId") AS "bountyId"
      FROM "Thread" t
      LEFT JOIN "Thread" r ON r.id = t."rootThreadId"
      WHERE t.id = $1`,
      [record.threadId]
    )

    if (!thread) return

    // Update the appropriate entity metric
    if (thread.postId) {
      const postMetric = actions.forMetric('Post', thread.postId).as(record.userId)
      postMetric.add('commentCount', value)
    }

    if (thread.imageId) {
      const imageMetric = actions.forMetric('Image', thread.imageId).as(record.userId)
      imageMetric.add('commentCount', value)
    }

    if (thread.articleId) {
      const articleMetric = actions.forMetric('Article', thread.articleId).as(record.userId)
      articleMetric.add('commentCount', value)
    }

    if (thread.bountyId) {
      const bountyMetric = actions.forMetric('Bounty', thread.bountyId).as(record.userId)
      bountyMetric.add('commentCount', value)
    }
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      threadId: faker.number.int({ min: 1, max: 5000 })
    }),
    pg: (sql: string) => {
      if (sql.includes('Thread')) {
        const entityType = faker.helpers.arrayElement(['post', 'image', 'article', 'bounty'])

        return {
          postId: entityType === 'post' ? faker.number.int({ min: 1, max: 5000 }) : null,
          imageId: entityType === 'image' ? faker.number.int({ min: 1, max: 5000 }) : null,
          articleId: entityType === 'article' ? faker.number.int({ min: 1, max: 5000 }) : null,
          bountyId: entityType === 'bounty' ? faker.number.int({ min: 1, max: 5000 }) : null
        }
      }
      return null
    }
  })
})