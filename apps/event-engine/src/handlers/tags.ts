import { createEventHandler } from './base'

export const tagsHandler = createEventHandler({
  tables: [
    'TagsOnPost',
    'TagsOnModels',
    'TagsOnImageNew',
    'TagsOnArticle',
    'TagsOnBounty'
  ],
  operations: ['create', 'delete'],
  processor: async ({ record, actions }) => {
    if ('postId' in record && record.postId) {
      actions.feedUpdate('Post', record.postId)
    } else if ('modelId' in record && record.modelId) {
      actions.feedUpdate('Model', record.modelId)
    } else if ('imageId' in record && record.imageId) {
      actions.feedUpdate('Image', record.imageId)
    } else if ('articleId' in record && record.articleId) {
      actions.feedUpdate('Article', record.articleId)
    } else if ('bountyId' in record && record.bountyId) {
      actions.feedUpdate('Bounty', record.bountyId)
    }
  },
  debug: (faker) => ({
    sample: () => {
      const tables = [
        { postId: faker.number.int({ min: 1, max: 10000 }), tagId: faker.number.int({ min: 1, max: 1000 }) },
        { modelId: faker.number.int({ min: 1, max: 10000 }), tagId: faker.number.int({ min: 1, max: 1000 }) },
        { imageId: faker.number.int({ min: 1, max: 10000 }), tagId: faker.number.int({ min: 1, max: 1000 }) },
        { articleId: faker.number.int({ min: 1, max: 10000 }), tagId: faker.number.int({ min: 1, max: 1000 }) },
        { bountyId: faker.number.int({ min: 1, max: 10000 }), tagId: faker.number.int({ min: 1, max: 1000 }) }
      ]
      return faker.helpers.arrayElement(tables)
    }
  })
})