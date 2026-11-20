import * as z from 'zod';
import {
  queueCollectionsReindex,
  queueModelsReindexSchema,
} from '~/server/search-index/queue-models-reindex';
import { getCollectionPageCoveredByHeldModels } from '~/server/services/collection-index-sync';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Backfill: the indexer applies the held cover rule only to documents it rewrites, so collections
 * whose cover may come from a model flagged before the rule need a requeue. The response is read
 * back from the queue; see `queueModelsReindex` for what `landed` proves.
 *
 * One page of `collections` collections scanned per request, from `cursor` (a collection id,
 * exclusive): call again with the returned `nextCursor` until `done`. `matched` of the `scanned`
 * are queued.
 */

const schema = queueModelsReindexSchema.extend({
  cursor: z.coerce.number().int().min(0).default(0),
  collections: z.coerce.number().int().min(1).max(5000).default(1000),
});

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { cursor, collections, ...options } = parsed.data;

  const { collectionIds, scanned, lastScannedId } = await getCollectionPageCoveredByHeldModels({
    cursor,
    limit: collections,
  });
  const done = scanned < collections;

  return res.status(200).json({
    ...(await queueCollectionsReindex(collectionIds, options)),
    scanned,
    matched: collectionIds.length,
    nextCursor: done ? null : lastScannedId,
    done,
  });
});
