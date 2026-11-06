import type { HandlerActions } from '@/types/handlers'
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
- status changes (update): a 0 on each of the above, to mark the entity for a recount
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

// Model, Post and Article collectedCount and Collection itemCount are counted from Postgres by
// the metric jobs (src/server/metrics/collection-item-counts.ts); for those, these events only
// mark the entity for a recount, so a row with no adder still marks them, as user -1 (the
// processor drops events with no user). Only ACCEPTED rows count, so a status change is marked
// too, with a 0 that moves no sum, on the row as it was and as it is. Image's 'Collection' is
// still the sum of these events, attributed to the adder.
function emit(record: CollectionItemRecord, value: number, actions: HandlerActions) {
  const marker = record.addedById ?? -1

  actions.forMetric('Collection', record.collectionId).as(marker).add('itemCount', value)
  if (record.modelId) actions.forMetric('Model', record.modelId).as(marker).add('collectedCount', value)
  if (record.postId) actions.forMetric('Post', record.postId).as(marker).add('collectedCount', value)
  // Named to match existing metric
  if (record.imageId) actions.forMetric('Image', record.imageId).as(record.addedById ?? 0).add('Collection', value)
  if (record.articleId) actions.forMetric('Article', record.articleId).as(marker).add('collectedCount', value)
}

export const collectionItemHandler = createEventHandler<CollectionItemRecord>({
  tables: ['CollectionItem'],
  operations: ['create', 'update', 'delete'],
  processor: async ({ operation, record, current, old, actions }) => {
    if (operation === 'update') {
      if (current && old && current.status !== old.status) {
        emit(old, 0, actions)
        emit(current, 0, actions)
      }
      return
    }
    emit(record, operation === 'create' ? 1 : -1, actions)
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