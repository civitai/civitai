import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import {
  queueCollectionsReindex,
  queueModelsReindexSchema,
} from '~/server/search-index/queue-models-reindex';
import { getCollectionIdsCoveredByModels } from '~/server/services/collection-index-sync';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Backfill: the indexer applies the held cover rule only to documents it rewrites, so collections
 * whose cover may come from a model flagged before the rule need a requeue. The response is read
 * back from the queue; see `queueModelsReindex` for what `landed` proves.
 *
 * One page of held models per request, from `cursor` (a model id, exclusive): call again with the
 * returned `nextCursor` until `done`.
 */

const schema = queueModelsReindexSchema.extend({
  cursor: z.coerce.number().int().min(0).default(0),
  models: z.coerce.number().int().min(1).max(5000).default(500),
});

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { cursor, models, ...options } = parsed.data;

  const page = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT m.id FROM "Model" m
    WHERE (m.minor OR m."sfwOnly") AND m.id > ${cursor}
    ORDER BY m.id
    LIMIT ${models}
  `;
  const modelIds = page.map((m) => Number(m.id));
  const collectionIds = await getCollectionIdsCoveredByModels(modelIds);
  const done = modelIds.length < models;

  return res.status(200).json({
    ...(await queueCollectionsReindex(collectionIds, options)),
    modelCount: modelIds.length,
    nextCursor: done ? null : modelIds[modelIds.length - 1],
    done,
  });
});
