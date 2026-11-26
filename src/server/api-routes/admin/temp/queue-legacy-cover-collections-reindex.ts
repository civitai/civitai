import * as z from 'zod';
import {
  queueCollectionsReindex,
  queueModelsReindexSchema,
} from '~/server/search-index/queue-models-reindex';
import { getCollectionIdsWithWithheldLegacyCover } from '~/server/services/collection-index-sync';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Backfill: the indexer applies the legacy cover string rule only to documents it rewrites, so
 * collections with an article item whose string it now withholds need a requeue. A collection
 * whose articles' strings are all still served is not selected. The response is read back from
 * the queue; see `queueModelsReindex` for what `landed` proves.
 *
 * One page of collections per request, from `cursor` (a collection id, exclusive): call again with
 * the returned `nextCursor` until `done`.
 */

const schema = queueModelsReindexSchema.extend({
  cursor: z.coerce.number().int().min(0).default(0),
  collections: z.coerce.number().int().min(1).max(10000).default(1000),
});

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { cursor, collections, ...options } = parsed.data;

  const ids = await getCollectionIdsWithWithheldLegacyCover({ cursor, limit: collections });
  const done = ids.length < collections;

  return res.status(200).json({
    ...(await queueCollectionsReindex(ids, options)),
    nextCursor: done ? null : ids[ids.length - 1],
    done,
  });
});
