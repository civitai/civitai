import { createEventHandler } from './base'

/**
## Metrics driven by collectionItem table:
- ModelMetric.favoriteCount (create/delete) (deprecate)
- ModelMetric.collectedCount (create/delete)
- ModelVersionMetric.favoriteCount (create/delete) (deprecate)
- ModelVersionMetric.collectedCount (create/delete) (deprecate)
- PostMetric.collectedCount (create/delete)
- ImageMetric.collectedCount (create/delete)
- ArticleMetric.favoriteCount (create/delete) (deprecate)
- ArticleMetric.collectedCount (create/delete)
- CollectionMetric.itemCount (create/delete)
*/

enum CollectionItemStatus {
  ACCEPTED = 'ACCEPTED',
  REVIEW = 'REVIEW',
  REJECTED = 'REJECTED'
}

interface CollectionItemRecord {
  id: number
  createdAt?: Date | null
  updatedAt?: Date | null
  collectionId: number
  articleId?: number | null
  postId?: number | null
  imageId?: number | null
  modelId?: number | null
  addedById?: number | null
  reviewedById?: number | null
  reviewedAt?: Date | null
  note?: string | null
  status: CollectionItemStatus
  randomId?: number | null
  tagId?: number | null
}

export const collectionItemHandler = createEventHandler<CollectionItemRecord>({
  tables: ['CollectionItem'],
  operations: ['create', 'delete'],
  processor: async ({ operation, record, actions, pg }) => {
    const value = operation === 'create' ? 1 : -1
    const addedBy = record.addedById ?? 0

    // Update collection metric
    const collectionMetric = actions.forMetric('Collection', record.collectionId).as(addedBy)
    collectionMetric.add('itemCount', value)

    // Handle model metrics
    if (record.modelId) {
      const modelMetric = actions.forMetric('Model', record.modelId).as(addedBy)
      modelMetric.add('collectedCount', value)
    }

    // Handle post metrics
    if (record.postId) {
      const postMetric = actions.forMetric('Post', record.postId).as(addedBy)
      postMetric.add('collectedCount', value)
    }

    // Handle image metrics
    if (record.imageId) {
      const imageMetric = actions.forMetric('Image', record.imageId).as(addedBy)
      imageMetric.add('Collection', value) // Named to match existing metric
    }

    // Handle article metrics
    if (record.articleId) {
      const articleMetric = actions.forMetric('Article', record.articleId).as(addedBy)
      articleMetric.add('collectedCount', value)
    }
  },
  debug: (faker) => ({
    sample: () => {
      const entityType = faker.helpers.arrayElement(['model', 'post', 'image', 'article'])

      return {
        id: faker.number.int({ min: 1, max: 10000 }),
        collectionId: faker.number.int({ min: 1, max: 5000 }),
        modelId: entityType === 'model' ? faker.number.int({ min: 1, max: 5000 }) : null,
        postId: entityType === 'post' ? faker.number.int({ min: 1, max: 5000 }) : null,
        imageId: entityType === 'image' ? faker.number.int({ min: 1, max: 5000 }) : null,
        articleId: entityType === 'article' ? faker.number.int({ min: 1, max: 5000 }) : null,
        addedById: faker.helpers.maybe(() => faker.number.int({ min: 1, max: 1000 }), { probability: 0.9 }),
        status: faker.helpers.arrayElement(['ACCEPTED', 'REVIEW', 'REJECTED'] as CollectionItemStatus[])
      }
    }
  })
})