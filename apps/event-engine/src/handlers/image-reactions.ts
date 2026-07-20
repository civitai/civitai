import { createEventHandler, createReactionHandler } from './base'

/**
## Metrics driven by imageReaction table:
- UserMetric.reactionCount (create/delete)
- PostMetric.Like (create/delete where reaction='Like')
- PostMetric.Dislike (create/delete where reaction='Dislike')
- PostMetric.Laugh (create/delete where reaction='Laugh')
- PostMetric.Cry (create/delete where reaction='Cry')
- PostMetric.Heart (create/delete where reaction='Heart')
- ImageMetric.Like (create/delete where reaction='Like')
- ImageMetric.Dislike (create/delete where reaction='Dislike')
- ImageMetric.Laugh (create/delete where reaction='Laugh')
- ImageMetric.Cry (create/delete where reaction='Cry')
- ImageMetric.Heart (create/delete where reaction='Heart')
- ImageMetric.reactionCount (create/delete)
*/

interface ImageReactionRecord {
  imageId: number
  userId: number
  reaction: string
}

export const imageReactionHandler = createReactionHandler<ImageReactionRecord>({
  table: 'ImageReaction',
  entityIdField: 'imageId',
  entityType: 'Image',
  async postProcessing({ record, pg, actions }, value) {
    const { postId, userId } = await pg.queryOne<{ postId: number | null, userId: number | null }>(
      'SELECT "postId", "userId" FROM "Image" WHERE id = $1',
      [record.imageId]
    ) ?? {};

    const postMetric = actions.forMetric('Post', postId).as(record.userId)
    postMetric.add(record.reaction, value)
    postMetric.add('reactionCount', value)

    const imageOwnerMetric = actions.forMetric('User', userId).as(record.userId)
    imageOwnerMetric.add('reactionCount', value)
  },
  debug: (faker) => ({
    sample: () => ({
      imageId: faker.number.int({ min: 1, max: 5000 }),
      userId: faker.number.int({ min: 1, max: 1000 }),
      reaction: faker.helpers.arrayElement(['Like', 'Dislike', 'Heart', 'Laugh', 'Cry'])
    }),
    pg: (sql: string) => {
      if (sql.includes('"Image"')) {
        return {
          postId: faker.number.int({ min: 1, max: 1000 }),
          userId: faker.number.int({ min: 1, max: 1000 })
        }
      }
      return null;
    }
  })
})