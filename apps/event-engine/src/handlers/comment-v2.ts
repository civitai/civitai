import { createEventHandler } from './base'

/**
## Metrics driven by commentv2 table:
- PostMetric.commentCount (create/delete)
- ImageMetric.commentCount (create/delete)
- ArticleMetric.commentCount (create/delete)
- BountyMetric.commentCount (create/delete)
- UserMetric.commentCount (create/delete) — comments *received* by the owner of the commented-on entity
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

    // One query for the entity *and* its owner: the owner columns are what make a per-creator comment
    // count possible at all. Without them the only route from a creator to their comments is a join
    // over the whole image space, which is why Creator Studio reads Postgres for this today.
    const thread = await pg.queryOne<{
      postId: number | null
      imageId: number | null
      articleId: number | null
      bountyId: number | null
      postOwnerId: number | null
      imageOwnerId: number | null
      articleOwnerId: number | null
      bountyOwnerId: number | null
    }>(
      `SELECT
        COALESCE(r."postId", t."postId") AS "postId",
        COALESCE(r."imageId", t."imageId") AS "imageId",
        COALESCE(r."articleId", t."articleId") AS "articleId",
        COALESCE(r."bountyId", t."bountyId") AS "bountyId",
        p."userId" AS "postOwnerId",
        i."userId" AS "imageOwnerId",
        a."userId" AS "articleOwnerId",
        b."userId" AS "bountyOwnerId"
      FROM "Thread" t
      LEFT JOIN "Thread" r ON r.id = t."rootThreadId"
      LEFT JOIN "Post" p ON p.id = COALESCE(r."postId", t."postId")
      LEFT JOIN "Image" i ON i.id = COALESCE(r."imageId", t."imageId")
      LEFT JOIN "Article" a ON a.id = COALESCE(r."articleId", t."articleId")
      LEFT JOIN "Bounty" b ON b.id = COALESCE(r."bountyId", t."bountyId")
      WHERE t.id = $1`,
      [record.threadId]
    )

    if (!thread) return

    // A creator answering their own commenters is not engagement received. Left in, it dominates:
    // 71.4% / 60.9% / 57.6% of the raw total for userIds 1421581 / 2895 / 1279061. Keep this in step
    // with `reactions_owner_scores`, which excludes self-reactions for the same reason, and with
    // Creator Studio's tile, which excludes self-comments — a metric named the same thing on two
    // surfaces must not mean two things.
    const addOwnerCount = (ownerId: number | null) => {
      if (!ownerId || ownerId === record.userId) return
      actions.forMetric('User', ownerId).as(record.userId).add('commentCount', value)
    }

    // Update the appropriate entity metric
    if (thread.postId) {
      const postMetric = actions.forMetric('Post', thread.postId).as(record.userId)
      postMetric.add('commentCount', value)
      addOwnerCount(thread.postOwnerId)
    }

    if (thread.imageId) {
      const imageMetric = actions.forMetric('Image', thread.imageId).as(record.userId)
      imageMetric.add('commentCount', value)
      addOwnerCount(thread.imageOwnerId)
    }

    if (thread.articleId) {
      const articleMetric = actions.forMetric('Article', thread.articleId).as(record.userId)
      articleMetric.add('commentCount', value)
      addOwnerCount(thread.articleOwnerId)
    }

    if (thread.bountyId) {
      const bountyMetric = actions.forMetric('Bounty', thread.bountyId).as(record.userId)
      bountyMetric.add('commentCount', value)
      addOwnerCount(thread.bountyOwnerId)
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
        const ownerId = faker.number.int({ min: 1, max: 1000 })

        return {
          postId: entityType === 'post' ? faker.number.int({ min: 1, max: 5000 }) : null,
          imageId: entityType === 'image' ? faker.number.int({ min: 1, max: 5000 }) : null,
          articleId: entityType === 'article' ? faker.number.int({ min: 1, max: 5000 }) : null,
          bountyId: entityType === 'bounty' ? faker.number.int({ min: 1, max: 5000 }) : null,
          postOwnerId: entityType === 'post' ? ownerId : null,
          imageOwnerId: entityType === 'image' ? ownerId : null,
          articleOwnerId: entityType === 'article' ? ownerId : null,
          bountyOwnerId: entityType === 'bounty' ? ownerId : null
        }
      }
      return null
    }
  })
})
