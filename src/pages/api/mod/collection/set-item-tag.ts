import * as z from 'zod';
import { setCollectionItemsTag } from '~/server/services/collection.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const id = z.coerce.number().int().positive();

export default defineModeratorEndpoint('collection.setItemTag', {
  summary: 'Set or clear the category tag on entries in a collection.',
  returns: '{ count }',
  notes: [
    'Every item must already be in the collection, or nothing is changed.',
    '`count` below the number of items means an entry gained a system tag mid-call and was left as it was.',
    '`tagId` must be one of the collection’s category tags; `null` clears it.',
    'Entries holding a system tag (challenge judging or review state) are refused.',
  ],
  rateLimit: { max: 20, windowSeconds: 60 },
  input: z.object({
    collectionId: id.describe('The collection the entries belong to.'),
    items: z
      .object({
        type: z.enum(['collectionItem', 'image', 'model', 'post', 'article']),
        ids: z.array(id).min(1).max(500),
      })
      .describe(
        'Collection item ids, or the ids of the entries’ images, models, posts or articles.'
      ),
    tagId: id.nullable().describe('The tag to set, or `null` to clear it.'),
  }),
  async handler(input) {
    const { count, collectionItemIds } = await setCollectionItemsTag(input);
    return {
      count,
      affected: {
        collectionIds: [input.collectionId],
        collectionItemIds,
        tagId: input.tagId,
        count,
      },
    };
  },
});
